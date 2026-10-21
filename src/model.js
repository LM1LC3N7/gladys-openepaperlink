// -----------------------------------------------------------------------------
// The access point and its tags -> Gladys devices and states (pure).
//
// Read only: no switch, no command feature. A text reaches a tag through the
// scene action only. Units: only those the core lists for the category
// (`percent` for the battery, `celsius` for the device temperature).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  AP_FEATURES,
  AP_ID,
  AP_STATES,
  AP_TYPE,
  LIMITS,
  TAG_FEATURES,
  TAG_TYPE,
} from './constants.js';

const readOnly = { read_only: true, has_feedback: false };

const AP_NAMES = {
  [AP_FEATURES.ONLINE]: { en: 'Reachable', fr: 'Joignable' },
  [AP_FEATURES.STATE]: { en: 'Radio state', fr: 'État de la radio' },
  [AP_FEATURES.LOW_BATTERY]: { en: 'Tags with a low battery', fr: 'Étiquettes à batterie faible' },
  [AP_FEATURES.TIMEOUT]: { en: 'Tags overdue', fr: 'Étiquettes en retard' },
};

const TAG_NAMES = {
  [TAG_FEATURES.BATTERY]: { en: 'Battery', fr: 'Batterie' },
  [TAG_FEATURES.TEMPERATURE]: { en: 'Temperature', fr: 'Température' },
  [TAG_FEATURES.REACHABLE]: { en: 'Reachable', fr: 'Joignable' },
  [TAG_FEATURES.LAST_SEEN]: { en: 'Last contact', fr: 'Dernier contact' },
};

export const AP_SPECS = Object.freeze({
  [AP_FEATURES.ONLINE]: { category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1, ...readOnly },
  [AP_FEATURES.STATE]: { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, ...readOnly },
  [AP_FEATURES.LOW_BATTERY]: {
    category: C.UNKNOWN,
    type: T.SENSOR.INTEGER,
    min: 0,
    max: 100_000,
    ...readOnly,
  },
  [AP_FEATURES.TIMEOUT]: {
    category: C.UNKNOWN,
    type: T.SENSOR.INTEGER,
    min: 0,
    max: 100_000,
    ...readOnly,
  },
});

export const TAG_SPECS = Object.freeze({
  [TAG_FEATURES.BATTERY]: {
    category: C.BATTERY,
    type: T.BATTERY.INTEGER,
    unit: U.PERCENT,
    min: 0,
    max: 100,
    keep_history: true,
    ...readOnly,
  },
  [TAG_FEATURES.TEMPERATURE]: {
    category: C.DEVICE_TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 100,
    keep_history: true,
    ...readOnly,
  },
  [TAG_FEATURES.REACHABLE]: {
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    ...readOnly,
  },
  [TAG_FEATURES.LAST_SEEN]: { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, ...readOnly },
});

/** Features published again after a while even when unchanged (history). */
export const HEARTBEAT_FEATURES = new Set([TAG_FEATURES.BATTERY, TAG_FEATURES.TEMPERATURE]);

export const apIds = (gladys) => gladys.externalIds(AP_TYPE, AP_ID);
export const tagIds = (gladys, mac) => gladys.externalIds(TAG_TYPE, mac);
export const tagName = (tag) => tag?.alias || `OpenEPaperLink ${tag?.mac ?? ''}`.trim();

/**
 * One device. `created` (the device as Gladys has it, from `gladys.devices`)
 * adds back any feature this list would not have: a device published again
 * never loses a feature.
 */
function device(name, ids, specs, names, language, created) {
  const features = Object.entries(specs).map(([key, spec]) => ({
    name: (names[key][language] ?? names[key].en).slice(0, LIMITS.text),
    external_id: ids.feature(key),
    read_only: true,
    has_feedback: false,
    keep_history: false,
    ...spec,
  }));
  const known = new Set(features.map((f) => f.external_id));
  for (const f of Array.isArray(created?.features) ? created.features : []) {
    if (f && typeof f.external_id === 'string' && !known.has(f.external_id)) {
      known.add(f.external_id);
      features.push({ ...f });
    }
  }
  return {
    name: name.slice(0, LIMITS.name),
    external_id: ids.device,
    should_poll: false,
    features,
  };
}

export const buildApDevice = (gladys, language = 'fr', created = undefined) =>
  device('OpenEPaperLink AP', apIds(gladys), AP_SPECS, AP_NAMES, language, created);

export const buildTagDevice = (gladys, tag, language = 'fr', created = undefined) =>
  device(tagName(tag), tagIds(gladys, tag.mac), TAG_SPECS, TAG_NAMES, language, created);

/**
 * Battery level from the voltage, as the reference integration estimates it
 * (`_calculate_battery_percentage`): 2.2 V is 0 %, 2.6 V and above 100 %.
 */
export function batteryPercent(mv) {
  if (!Number.isInteger(mv) || mv <= 0) {
    return undefined;
  }
  // (mv / 1000 - 2.2) * 250, in whole numbers: no floating point rounding.
  return Math.max(0, Math.min(100, Math.trunc((mv - 2200) / 4)));
}

/** "2026-10-21 14:05 UTC" for epoch seconds. */
export const lastSeenText = (seconds) =>
  `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Whether a tag checked in on time: before its expected check-in plus a
 * grace, else (no expected check-in known) seen within the last hour.
 * Undefined when nothing is known.
 */
export function reachable(tag, nowMs, timings) {
  if (Number.isInteger(tag.nextCheckin)) {
    return nowMs <= tag.nextCheckin * 1000 + timings.checkinGrace;
  }
  if (Number.isInteger(tag.lastSeen)) {
    return nowMs - tag.lastSeen * 1000 <= timings.seenRecently;
  }
  return undefined;
}

/**
 * The states of one tag as { key, value } (`value` a number, or { text }).
 * A value missing from the record publishes nothing. A tag served by
 * another access point (`external`) or without a battery voltage has no
 * battery state.
 */
export function tagStates(tag, nowMs, timings) {
  const out = [];
  const battery = tag.external ? undefined : batteryPercent(tag.batteryMv);
  if (battery !== undefined) {
    out.push({ key: TAG_FEATURES.BATTERY, value: battery });
  }
  if (typeof tag.temperature === 'number' && Number.isFinite(tag.temperature)) {
    out.push({ key: TAG_FEATURES.TEMPERATURE, value: Math.round(tag.temperature * 10) / 10 });
  }
  const isReachable = reachable(tag, nowMs, timings);
  if (isReachable !== undefined) {
    out.push({ key: TAG_FEATURES.REACHABLE, value: isReachable ? 1 : 0 });
  }
  if (Number.isInteger(tag.lastSeen)) {
    out.push({ key: TAG_FEATURES.LAST_SEEN, value: { text: lastSeenText(tag.lastSeen) } });
  }
  return out;
}

/** The states of the access point: { online, sys? } -> [{ key, value }]. */
export function apStates(view, language = 'fr') {
  const out = [{ key: AP_FEATURES.ONLINE, value: view.online ? 1 : 0 }];
  if (!view.online || !view.sys) {
    return out;
  }
  const state = AP_STATES[view.sys.apState];
  if (state) {
    out.push({ key: AP_FEATURES.STATE, value: { text: state[language] ?? state.en } });
  }
  if (Number.isInteger(view.sys.lowBattery)) {
    out.push({ key: AP_FEATURES.LOW_BATTERY, value: view.sys.lowBattery });
  }
  if (Number.isInteger(view.sys.timeout)) {
    out.push({ key: AP_FEATURES.TIMEOUT, value: view.sys.timeout });
  }
  return out;
}
