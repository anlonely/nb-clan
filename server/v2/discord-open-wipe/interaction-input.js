import { requireValue } from '../identity/errors.js';

export const OPEN_WIPE_PREFIX = 'nbopen';
export const OPEN_WIPE_BUTTON_ACTIONS = Object.freeze([
  'settings', 'publish', 'server', 'language', 'signup_on_time',
  'signup_8h', 'signup_16h', 'signup_absent', 'signup_late', 'copy', 'edit_details',
]);
export const OPEN_WIPE_SELECT_ACTIONS = Object.freeze(['select_server']);
export const OPEN_WIPE_MODAL_ACTIONS = Object.freeze(['create_submit', 'settings_submit']);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const valid = condition => requireValue(condition, 'PLATFORM_PAYLOAD_INVALID', 422);
const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function openWipeCustomId(action, token) {
  valid([...OPEN_WIPE_BUTTON_ACTIONS, ...OPEN_WIPE_SELECT_ACTIONS, ...OPEN_WIPE_MODAL_ACTIONS].includes(action) && tokenPattern.test(token));
  return `${OPEN_WIPE_PREFIX}:${action}:${token}`;
}

export function ownsOpenWipeInteraction(event) {
  return Boolean(event?.type === 2 && event.data?.name === 'newwipe' ||
    typeof event?.data?.custom_id === 'string' && event.data.custom_id.startsWith(`${OPEN_WIPE_PREFIX}:`));
}

function fields(components, names) {
  valid(Array.isArray(components) && components.length === names.length);
  const result = Object.create(null);
  for (const row of components) {
    valid(object(row) && row.type === 18 && object(row.component));
    const field = row.component;
    valid(names.includes(field.custom_id) && !Object.hasOwn(result, field.custom_id));
    result[field.custom_id] = field;
  }
  return result;
}

function input(field, max, required = false, multiline = false) {
  valid(field?.type === 4 && typeof field.value === 'string' && field.value.length <= max &&
    !control.test(field.value) && (multiline || !/[\r\n\t]/.test(field.value)));
  const value = field.value.trim();
  valid(!required || value.length > 0);
  return value;
}

function preferences(field) {
  valid(field?.type === 22 && Array.isArray(field.values) && field.values.length <= 2 &&
    new Set(field.values).size === field.values.length && field.values.every(value => ['adaptiveDisplay', 'autoConnect'].includes(value)));
  return { adaptiveDisplay: field.values.includes('adaptiveDisplay'), autoConnect: field.values.includes('autoConnect') };
}

/** Parse only data authenticated by the native verifier; this does not grant authority. */
export function parseOpenWipeInteraction(event) {
  if (!ownsOpenWipeInteraction(event)) return null;
  const data = event.data;
  if (event.type === 2) {
    valid(data.name === 'newwipe' && (data.type === undefined || data.type === 1) &&
      (data.options === undefined || Array.isArray(data.options) && data.options.length === 0));
    return { kind: 'open_wipe', action: 'open' };
  }
  const parts = data.custom_id.split(':');
  valid(parts.length === 3 && parts[0] === OPEN_WIPE_PREFIX && tokenPattern.test(parts[2]));
  const [, action, token] = parts;
  if (OPEN_WIPE_SELECT_ACTIONS.includes(action)) {
    valid(event.type === 3 && data.component_type === 3 && Array.isArray(data.values) && data.values.length === 1 &&
      typeof data.values[0] === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(data.values[0]));
    return { kind: 'open_wipe', action, token, values: { serverId: data.values[0] } };
  }
  if (OPEN_WIPE_BUTTON_ACTIONS.includes(action)) {
    valid(event.type === 3 && data.component_type === 2 && data.values === undefined);
    return { kind: 'open_wipe', action, token };
  }
  valid(event.type === 5 && OPEN_WIPE_MODAL_ACTIONS.includes(action));
  const form = fields(data.components, action === 'create_submit'
    ? ['serverId', 'preferences', 'directConnect', 'notes']
    : ['wipeAtLocal', 'timeZone', 'directConnect', 'notes', 'preferences']);
  const values = { ...preferences(form.preferences), directConnect: input(form.directConnect, 300), notes: input(form.notes, 1000, false, true) };
  if (action === 'create_submit') {
    valid(form.serverId.type === 3 && Array.isArray(form.serverId.values) && form.serverId.values.length === 1 &&
      typeof form.serverId.values[0] === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(form.serverId.values[0]));
    values.serverId = form.serverId.values[0];
  } else {
    values.wipeAtLocal = input(form.wipeAtLocal, 16, true).replace(' ', 'T');
    valid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(values.wipeAtLocal));
    values.timeZone = input(form.timeZone, 80, true);
    valid(/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(values.timeZone));
  }
  return { kind: 'open_wipe', action, token, values };
}
