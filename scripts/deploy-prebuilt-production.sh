#!/usr/bin/env bash
set -Eeuo pipefail

HOST="${1:?Usage: deploy-prebuilt-production.sh user@host /absolute/remote/path}"
REMOTE_DIR="${2:?An explicit absolute remote directory is required}"
[[ "${HOST}" =~ ^[A-Za-z0-9_.@:-]+$ && "${HOST}" != -* && "${REMOTE_DIR}" =~ ^/[A-Za-z0-9_./-]+$ && "${REMOTE_DIR}" != / ]] || { echo 'Invalid deployment target' >&2; exit 2; }
READINESS_URL="${NB_READINESS_URL:-http://127.0.0.1:8787/api/readyz}"
READINESS_TIMEOUT="${NB_READINESS_TIMEOUT_SECONDS:-120}"
APP_UID="${NB_CONTAINER_UID:-10001}"
APP_GID="${NB_CONTAINER_GID:-10001}"

if ! [[ "${READINESS_TIMEOUT}" =~ ^[0-9]+$ ]] || (( READINESS_TIMEOUT < 10 )); then
  echo "NB_READINESS_TIMEOUT_SECONDS must be an integer >= 10" >&2
  exit 2
fi
if ! [[ "${APP_UID}" =~ ^[0-9]+$ && "${APP_GID}" =~ ^[0-9]+$ ]]; then
  echo "NB_CONTAINER_UID and NB_CONTAINER_GID must be numeric" >&2
  exit 2
fi

if [[ "${NB_SKIP_LOCAL_BUILD:-0}" != "1" ]]; then
  npm run build
fi
test -f dist/index.html

# Export a scanned allowlist, never rsync the entire working tree.
release_dir="$(mktemp -d "${TMPDIR:-/tmp}/nb-clan-release.XXXXXX")"
trap 'rm -rf "${release_dir}"' EXIT
node scripts/release-public.mjs --output "${release_dir}/source" --include-dist
rsync -az --delete --exclude='.env' --exclude='.env.*' --exclude='data' \
  --exclude='.secrets' --exclude='secrets' --exclude='credentials' \
  --exclude='.runtime' --exclude='root-credentials.txt' --exclude='*.sqlite*' --exclude='*.db*' \
  "${release_dir}/source/" "${HOST}:${REMOTE_DIR}/"

printf -v remote_command \
  'REMOTE_DIR=%q READINESS_URL=%q READINESS_TIMEOUT=%q APP_UID=%q APP_GID=%q bash -s' \
  "${REMOTE_DIR}" "${READINESS_URL}" "${READINESS_TIMEOUT}" "${APP_UID}" "${APP_GID}"

ssh "${HOST}" "${remote_command}" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
umask 077

cd "${REMOTE_DIR}"
test -f dist/index.html
command -v curl >/dev/null
docker compose version >/dev/null

SERVICE_NAME='nb-clan-member-system'
CONTAINER_NAME='nb-clan-member-system'
LATEST_IMAGE='nb-clan-member-system:latest'
ROLLBACK_IMAGE='nb-clan-member-system:rollback'
release_id="$(date -u +%Y%m%d%H%M%S)-$$"
candidate_image="nb-clan-member-system:release-${release_id}"
compose=(docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml -f docker-compose.bind-data.yml -f docker-compose.production.yml)
replacement_started=0
had_old_container=0
old_supports_bridge=0
old_container_user=''
old_container_network=''
rollback_env_file=''

log() {
  printf '[deploy] %s\n' "$*" >&2
}

cleanup() {
  if [[ -n "${rollback_env_file}" ]]; then
    rm -f "${rollback_env_file}"
  fi
}
trap cleanup EXIT

ready_payload_is_valid() {
  docker exec -i "${CONTAINER_NAME}" node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(input);
        process.exit(payload?.ok === true && payload?.service === "nb-clan-member-system" ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

wait_for_readiness() {
  local label="$1"
  local deadline=$((SECONDS + READINESS_TIMEOUT))
  local state health payload
  while (( SECONDS < deadline )); do
    state="$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Status}}' 2>/dev/null || true)"
    health="$(docker inspect "${CONTAINER_NAME}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    if [[ "${state}" == 'running' && "${health}" == 'healthy' ]]; then
      payload="$(curl -fsS --max-time 5 "${READINESS_URL}" 2>/dev/null || true)"
      if [[ -n "${payload}" ]] && printf '%s' "${payload}" | ready_payload_is_valid; then
        log "${label} is healthy and ready"
        return 0
      fi
    fi
    sleep 2
  done

  log "${label} failed readiness within ${READINESS_TIMEOUT}s"
  docker inspect "${CONTAINER_NAME}" --format '{{json .State}}' >&2 2>/dev/null || true
  docker logs --tail 120 "${CONTAINER_NAME}" >&2 2>/dev/null || true
  return 1
}

run_rollback_container() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  if [[ "${old_container_user}" =~ ^([0-9]+):([0-9]+)$ ]]; then
    chown -R "${BASH_REMATCH[1]}:${BASH_REMATCH[2]}" data
  elif [[ "${old_container_user}" =~ ^[0-9]+$ ]]; then
    chown -R "${old_container_user}" data
  elif [[ -n "${old_container_user}" ]]; then
    log "cannot restore data ownership for non-numeric previous user ${old_container_user}"
  fi
  if (( old_supports_bridge )); then
    local rollback_user_args=()
    local rollback_network_args=()
    if [[ -n "${old_container_user}" ]]; then
      rollback_user_args=(--user "${old_container_user}")
    fi
    if [[ -n "${old_container_network}" ]]; then
      rollback_network_args=(--network "${old_container_network}")
    fi
    docker run -d \
      --name "${CONTAINER_NAME}" \
      --restart unless-stopped \
      --init \
      "${rollback_user_args[@]}" \
      "${rollback_network_args[@]}" \
      --read-only \
      --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --cpus 1.5 \
      --memory 1536m \
      --pids-limit 256 \
      --stop-timeout 45 \
      --publish 127.0.0.1:8787:8787 \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777 \
      --env-file "${rollback_env_file}" \
      --volume "${REMOTE_DIR}/data:/app/data:rw" \
      "${ROLLBACK_IMAGE}" >/dev/null
    return
  fi

  log 'legacy rollback requires its previous host-network binding'
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 256 \
    --memory 1536m \
    --stop-timeout 45 \
    --network host \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777 \
    --env-file "${rollback_env_file}" \
    --env NB_BIND_HOST=127.0.0.1 \
    --volume "${REMOTE_DIR}/data:/app/data:rw" \
    "${ROLLBACK_IMAGE}" >/dev/null
}

rollback_on_error() {
  local deploy_rc=$?
  trap - ERR
  set +e
  if (( replacement_started && had_old_container )); then
    log 'candidate failed; restoring the previous image'
    run_rollback_container
    local rollback_start_rc=$?
    if (( rollback_start_rc == 0 )) && wait_for_readiness 'rollback container'; then
      docker image rm -f "${LATEST_IMAGE}" >/dev/null 2>&1 || true
      docker image tag "${ROLLBACK_IMAGE}" "${LATEST_IMAGE}"
      log 'rollback succeeded; deployment remains failed for operator visibility'
    else
      log 'rollback failed; the failed container and logs require operator action'
      deploy_rc=70
    fi
  elif (( replacement_started )); then
    log 'candidate failed and no previous container was available to restore'
  else
    log 'deployment failed before replacement; the previous container is still running'
  fi
  exit "${deploy_rc}"
}
trap rollback_on_error ERR

mkdir -p data

if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  had_old_container=1
  rollback_env_file="$(mktemp /tmp/nb-clan-rollback-env.XXXXXX)"
  chmod 0600 "${rollback_env_file}"
  docker inspect "${CONTAINER_NAME}" --format '{{range .Config.Env}}{{println .}}{{end}}' > "${rollback_env_file}"
  if grep -qx 'NB_BIND_HOST=0.0.0.0' "${rollback_env_file}"; then
    old_supports_bridge=1
  fi
  old_container_user="$(docker inspect "${CONTAINER_NAME}" --format '{{.Config.User}}')"
  old_container_network="$(docker inspect "${CONTAINER_NAME}" --format '{{range $name, $network := .NetworkSettings.Networks}}{{println $name}}{{end}}' | head -n 1)"
  old_image_id="$(docker inspect "${CONTAINER_NAME}" --format '{{.Image}}')"
  docker image rm -f "${ROLLBACK_IMAGE}" >/dev/null 2>&1 || true
  docker image tag "${old_image_id}" "${ROLLBACK_IMAGE}"
fi

log "building candidate image ${candidate_image} while the current container remains online"
docker build \
  --build-arg "APP_UID=${APP_UID}" \
  --build-arg "APP_GID=${APP_GID}" \
  --file Dockerfile.prebuilt \
  --tag "${candidate_image}" \
  .


replacement_started=1
if (( had_old_container )); then
  docker stop --time 45 "${CONTAINER_NAME}" >/dev/null
  docker rm "${CONTAINER_NAME}" >/dev/null
fi
chown -R "${APP_UID}:${APP_GID}" data
find data -xdev -type d -exec chmod 0700 {} +
find data -xdev -type f -exec chmod 0600 {} +

NB_IMAGE="${candidate_image}" \
NB_CONTAINER_UID="${APP_UID}" \
NB_CONTAINER_GID="${APP_GID}" \
  "${compose[@]}" up -d --no-deps --force-recreate "${SERVICE_NAME}"
wait_for_readiness 'candidate container'

docker image rm -f "${LATEST_IMAGE}" >/dev/null 2>&1 || true
docker image tag "${candidate_image}" "${LATEST_IMAGE}"
replacement_started=0
trap - ERR

docker inspect "${CONTAINER_NAME}" --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} image={{.Config.Image}}'
log "deployment succeeded; previous image retained as ${ROLLBACK_IMAGE}"
REMOTE_SCRIPT
