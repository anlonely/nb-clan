# Clan Portal

[简体中文](README.md) | [English](README.en.md)

Clan Portal is a self-hosted community management system for Rust gaming clans, with member and team management, wipe scheduling, sign-ups, player statistics, and role-based permissions. It provides Chinese and English web interfaces, with configurable Discord, KOOK, and external game-data integrations.

Built with React + Vite, Node.js + Express, and SQLite. Released under the AGPL-3.0-only license.

## Features and scope

- Member search, profile management, teams, and role-based access.
- Wipe schedules, sign-ups, notifications, history, and statistics queries and exports.
- Discord and KOOK bot configuration, community identity verification, and message interactions.
- Optional Steam, BattleMetrics, and Vital data sources, plus a WeChat Mini Program client.
- Background synchronization, audit records, health checks, and backup and recovery tools.

The core management interface can run without third-party credentials. Platform sign-in, notifications, external data collection, and the Mini Program require their own application configuration and network access. This repository does not include operator accounts, member records, or production credentials.

## Local quick start

Use **Node.js 22.23.1** (see `.node-version` and `.nvmrc`) and npm. Native execution is supported on macOS and Linux; use WSL2 or Docker on Windows.

```sh
npm ci
cp .env.example .env
npm run setup
npm run build
npm run doctor
npm start
```

Open http://127.0.0.1:8787/login and use administrator sign-in. The username is `root`; the randomly generated initial password is saved in `data/root-credentials.txt` and is not printed to the terminal. Running `setup` again checks an existing complete installation without overwriting its data.

Local mode accepts only loopback access and disables external OAuth and callbacks. To enable real platform integrations, configure HTTPS as described in the [installation guide (Chinese)](docs/INSTALLATION.md). For development, run `npm run dev` and open `http://127.0.0.1:5173`. The API runs on port 8787; the development command sets the expected origin explicitly and Vite proxies API requests.

## Docker

```sh
docker compose build
docker compose run --rm nb-clan-member-system node scripts/setup.mjs
docker compose up -d
```

The default configuration uses a named data volume and binds the host port to `127.0.0.1:8787`. Setup reports only the location of the credentials file; the administrator can read `root-credentials.txt` from the volume on their own machine. Do not expose local mode to the public internet.

See the [operations guide (Chinese)](docs/OPERATIONS.md) for production HTTPS, optional proxies, and bind mounts. Initial setup requires an empty data directory or volume. Back up an existing installation before upgrading it.

## Development and verification

```sh
npm run test:unit
npm run test:core
npm run test:integration
npm run test:migration
npm run test:browser
npm run test:mini
npm run build
npm run check:release
```

The browser suite requires Chrome or Chromium. Set `PUPPETEER_EXECUTABLE_PATH` to its executable if needed.

`npm test` runs all suites sequentially and builds the frontend before the integration suite. Tests use isolated data, and the test runner restricts external network access. Real platform acceptance testing requires separate configuration; passing offline tests does not establish that Discord, KOOK, or WeChat services have been validated in a live deployment.

`scopeContract: true` is used only for isolated capability and scope algorithm tests. Fixtures use the real identity service by default. HTTP, runtime, and fixed-role matrix tests verify the deployed owner/admin/member permissions.

## Documentation

The detailed guides below are currently in Chinese:

- [Installation and first sign-in](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Architecture and compatibility boundaries](docs/ARCHITECTURE.md)
- [Platform integrations](docs/INTEGRATIONS.md)
- [Backups, upgrades, and deployment](docs/OPERATIONS.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md) · [Changelog](CHANGELOG.md)

## License

This project is released under [GNU AGPL v3](LICENSE), with the SPDX identifier `AGPL-3.0-only`. If you modify the software and provide it as a network service, make the corresponding source available to users as required by the license. The web interface includes a source-code link. For a modified deployment, set `VITE_SOURCE_URL` to the complete source for the version you run, then rebuild the frontend. Third-party dependencies remain subject to their respective licenses.

This project is not affiliated with Facepunch, Valve, Discord, KOOK, or WeChat. Their names are used only to identify compatible platforms.
