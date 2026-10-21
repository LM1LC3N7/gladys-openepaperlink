// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions and scene actions),
// the access point paths, limits and timings. Every key here is stored by
// Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(AP_TYPE, AP_ID)`: one access point per configuration. */
export const AP_TYPE = 'ap';
export const AP_ID = 'main';
/** `gladys.externalIds(TAG_TYPE, <16 hex digits of the tag MAC, upper case>)`. */
export const TAG_TYPE = 'tag';

export const AP_FEATURES = Object.freeze({
  /** Read only: 1 the websocket of the access point is open, 0 not. */
  ONLINE: 'online',
  /** Read only text: the radio state the access point reports (online, flashing…). */
  STATE: 'state',
  /** Read only: tags with a low battery, as the access point counts them. */
  LOW_BATTERY: 'low_battery_tags',
  /** Read only: tags that missed their check-in, as the access point counts them. */
  TIMEOUT: 'timeout_tags',
});

export const TAG_FEATURES = Object.freeze({
  /** Read only: battery level estimated from the voltage, %. */
  BATTERY: 'battery',
  /** Read only: temperature of the tag chip, °C. */
  TEMPERATURE: 'temperature',
  /** Read only: 1 the tag checked in on time, 0 overdue. */
  REACHABLE: 'reachable',
  /** Read only text: the last contact, "2026-10-21 14:05 UTC". */
  LAST_SEEN: 'last_seen',
});

export const ACTIONS = Object.freeze({
  RECONNECT: 'reconnect',
});

export const SCENE_ACTIONS = Object.freeze({
  SHOW_TEXT: 'show_text',
});

/** Options of the scene action fields (values stored in scenes: never rename). */
export const TEXT_COLORS = Object.freeze(['black', 'red', 'yellow', 'white']);
export const BACKGROUNDS = Object.freeze(['white', 'black']);
export const TEXT_SIZES = Object.freeze(['auto', 'small', 'medium', 'large']);
export const ALIGNMENTS = Object.freeze(['center', 'left']);

/** Paths of the HTTP API of the access point (OpenEPaperLink AP firmware). */
export const PATHS = Object.freeze({
  SYSINFO: '/sysinfo',
  DB: '/get_db',
  IMAGE_UPLOAD: '/imgupload',
  WEBSOCKET: '/ws',
  tagType: (hwType) =>
    `/tagtypes/${hwType > 0xff ? hwType.toString(16).toUpperCase().padStart(4, '0') : hwType.toString(16).toUpperCase().padStart(2, '0')}.json`,
});

/** Access point radio states (`apstate` of the `sys` messages). */
export const AP_STATES = Object.freeze({
  0: { en: 'Offline', fr: 'Hors ligne' },
  1: { en: 'Online', fr: 'En ligne' },
  2: { en: 'Flashing', fr: 'Mise à jour du radio' },
  3: { en: 'Waiting for reset', fr: 'En attente de réinitialisation' },
  4: { en: 'Requires power cycle', fr: 'Coupure de courant nécessaire' },
  5: { en: 'Failed', fr: 'En échec' },
  6: { en: 'Coming online', fr: 'Démarrage' },
  7: { en: 'No radio', fr: 'Sans radio' },
});

export const TIMINGS = Object.freeze({
  /** One HTTP exchange outside an upload. */
  httpTimeout: 5_000,
  /** The websocket handshake. */
  handshakeTimeout: 5_000,
  /** A ping on the websocket every this; no byte for `idleTimeout` closes it. */
  pingInterval: 30_000,
  idleTimeout: 90_000,
  /** A websocket frame or message must complete within this from its first byte. */
  frameTimeout: 30_000,
  /** Reconnection delays of the websocket (by attempt, the last one repeating). */
  reconnect: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** A connection held this long resets the reconnection delays. */
  stableAfter: 120_000,
  /** Never two connection attempts closer than this, restarts of the container included. */
  attemptSpacing: 10_000,
  /** The time of the last attempt is written to /data at most this often. */
  attemptWrite: 60_000,
  /** A tag renamed or added on the websocket republishes the Discovery at most this often. */
  discoveryDelay: 5_000,
  /** The whole tag list (`get_db`) is read at most this often (kept in /data). */
  resync: 15 * 60_000,
  /** The scene action: the whole job (queue included) must start before this. */
  sceneBudget: 25_000,
  /** One image upload (the AP converts the image while answering). */
  uploadTimeout: 15_000,
  /** At least this between two uploads to the access point, any tag. */
  uploadSpacing: 2_000,
  /** At least this between two uploads to the same tag. */
  tagSpacing: 15_000,
  /** 409 "busy" of an upload: a pause of Retry-After, bounded. */
  busyMin: 5_000,
  busyMax: 5 * 60_000,
  /** 429 or 5xx: a pause of this when the answer has no Retry-After, bounded by min and max. */
  pause429: 15 * 60_000,
  pause5xx: 5 * 60_000,
  pauseMin: 60_000,
  pauseMax: 6 * 3_600_000,
  /** States are sent to Gladys in groups, at most this often. */
  flushInterval: 5_000,
  /** Budget of states per minute (the core admits 300). */
  statesPerMinute: 240,
  /** Battery and temperature are published again after this even when unchanged (history). */
  heartbeat: 30 * 60_000,
  /** A tag is "reachable" until its expected check-in plus this. */
  checkinGrace: 10 * 60_000,
  /** Without an expected check-in, a tag seen within this is "reachable". */
  seenRecently: 60 * 60_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
});

export const LIMITS = Object.freeze({
  tags: 200,
  /** Largest HTTP answer read (one page of get_db is about 5 KB). */
  responseBytes: 64 * 1024,
  /** Pages of get_db read at most in one pass. */
  dbPages: 60,
  /** Largest websocket frame and message accepted. */
  wsMessageBytes: 64 * 1024,
  /** Fragments of one websocket message at most. */
  wsFragments: 32,
  /** Largest headers of the handshake answer. */
  wsHandshakeBytes: 8 * 1024,
  /** Pings in a row at most (a flood is closed). */
  wsPingsInARow: 100,
  /** Bytes left unread by the access point before the websocket is closed. */
  wsPendingWrite: 64 * 1024,
  /** Characters of the text to show (after cleaning). */
  textChars: 280,
  /** Lines of the text to show. */
  textLines: 16,
  /** Largest display accepted (width, height, pixels). */
  displaySide: 2_000,
  displayPixels: 2_000_000,
  /** Largest JPEG sent (the AP accepts 1 MB). */
  imageBytes: 512 * 1024,
  /** Texts waiting for the access point at most. */
  queue: 10,
  /** Length of a published text, and of a name. */
  text: 200,
  name: 64,
});
