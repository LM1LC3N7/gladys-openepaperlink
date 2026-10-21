// -----------------------------------------------------------------------------
// Readers of the access point answers and websocket messages (pure).
// Everything comes from the network: each field is checked for its type and
// bounded, a tag is keyed by its MAC (16 hex digits) only, and nothing is ever
// merged into an object as is.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

const MAC = /^[0-9A-F]{16}$/;

/** A tag MAC as the access point writes it: 16 hex digits, upper case. */
export const isMac = (mac) => typeof mac === 'string' && MAC.test(mac);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const num = (v, min, max) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

/** A short single-line text: control characters dropped, trimmed, cut at `max`. */
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, max);
}

/**
 * The base URL of the access point from what the user typed: `192.168.1.30`,
 * `oepl.local:8080` or `http://192.168.1.30/`. Plain HTTP only (the access
 * point has no TLS). Undefined when it is not a plain host.
 */
export function parseBaseUrl(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '' || text.length > 255 || /\s/.test(text)) {
    return undefined;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:') {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash || !url.hostname) {
    return undefined;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return undefined;
  }
  return `http://${url.host}`;
}

/** Epoch seconds that make sense (2020 to 2100), else undefined. */
const epoch = (v) => int(v, 1_577_836_800, 4_102_444_800);

/**
 * One tag record (`get_db` entry or websocket `tags[0]`):
 * { mac, alias?, hwType?, lastSeen?, nextCheckin?, batteryMv?, temperature?, external }.
 * Undefined when the MAC is not one.
 */
export function parseTag(json) {
  if (!isObject(json) || !isMac(json.mac)) {
    return undefined;
  }
  return {
    mac: json.mac,
    alias: cleanText(json.alias, LIMITS.name),
    hwType: int(json.hwType, 0, 0xffff),
    lastSeen: epoch(json.lastseen),
    nextCheckin: epoch(json.nextcheckin),
    batteryMv: int(json.batteryMv, 1, 10_000),
    temperature: num(json.temperature, -40, 100),
    external: json.isexternal === true || json.isexternal === 1,
  };
}

/**
 * One page of `get_db`: { tags: [tag], next? } (`next` is the `pos` of the
 * following page). Undefined when it is not a page.
 */
export function parseDbPage(json) {
  if (!isObject(json) || !Array.isArray(json.tags)) {
    return undefined;
  }
  const tags = [];
  for (const entry of json.tags.slice(0, LIMITS.tags)) {
    const tag = parseTag(entry);
    if (tag) {
      tags.push(tag);
    }
  }
  return { tags, next: int(json.continu, 1, 100_000) };
}

/** A `sys` message: { apState?, lowBattery?, timeout? }. */
export function parseSys(json) {
  if (!isObject(json)) {
    return undefined;
  }
  return {
    apState: int(json.apstate, 0, 255),
    lowBattery: int(json.lowbattcount, 0, 100_000),
    timeout: int(json.timeoutcount, 0, 100_000),
  };
}

/**
 * One websocket text message of the access point, as one of
 * { type: 'sys', sys }, { type: 'tag', tag }, { type: 'rebooting' }, or
 * undefined (anything else: logs, console lines, upload progress…).
 */
export function parseMessage(text) {
  const json = parseJson(text);
  if (!isObject(json)) {
    return undefined;
  }
  if (isObject(json.sys)) {
    return { type: 'sys', sys: parseSys(json.sys) };
  }
  if (Array.isArray(json.tags)) {
    const tag = parseTag(json.tags[0]);
    return tag ? { type: 'tag', tag } : undefined;
  }
  if (json.errMsg === 'REBOOTING') {
    return { type: 'rebooting' };
  }
  return undefined;
}

const COLOR = /^[a-z]{1,16}$/;

/**
 * A tag type (`/tagtypes/XX.json`): { width, height, colors } where `colors`
 * maps a colour name to [r, g, b]. Undefined when the size is missing or out
 * of bounds (a segmented display has none).
 */
export function parseTagType(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const width = int(json.width, 8, LIMITS.displaySide);
  const height = int(json.height, 8, LIMITS.displaySide);
  if (!width || !height || width * height > LIMITS.displayPixels) {
    return undefined;
  }
  const colors = new Map();
  if (isObject(json.colortable)) {
    for (const [name, rgb] of Object.entries(json.colortable).slice(0, 16)) {
      if (
        COLOR.test(name) &&
        Array.isArray(rgb) &&
        rgb.length === 3 &&
        rgb.every((c) => int(c, 0, 255) !== undefined)
      ) {
        colors.set(name, [rgb[0], rgb[1], rgb[2]]);
      }
    }
  }
  return { width, height, colors };
}

/** A JSON body, or undefined (never throws). */
export function parseJson(text) {
  if (typeof text !== 'string' || text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
