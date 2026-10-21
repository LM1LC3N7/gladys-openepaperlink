// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600). The access point has no password: nothing secret
// is kept.
//
//   tags         the tags seen (MAC, name, hardware type), so the Discovery
//                tab is filled again while the access point is away;
//   pause        the end of a pause asked by the access point (429, 5xx);
//   attemptAt    the time of the last connection attempt (written at most
//                once a minute), so a container restarting in a loop never
//                connects faster than the spacing.
//
// The tag table has no prototype and only 16-hex-digit MACs are keys.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, TIMINGS } from './constants.js';
import { cleanText, isMac } from './ap/parse.js';

export const emptyData = () => ({
  tags: Object.create(null),
  pause: null,
  attemptAt: null,
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The saved data, checked field by field; `now` bounds the saved times. */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (isObject(data.tags)) {
    for (const [mac, tag] of Object.entries(data.tags).slice(0, LIMITS.tags)) {
      if (isMac(mac) && isObject(tag) && tag.mac === mac) {
        base.tags[mac] = {
          mac,
          alias: cleanText(tag.alias, LIMITS.name) ?? null,
          hwType: Number.isInteger(tag.hwType) && tag.hwType >= 0 ? tag.hwType : null,
        };
      }
    }
  }
  const p = data.pause;
  if (isObject(p) && Number.isFinite(p.until) && p.until > now) {
    // A saved end is never trusted beyond the longest pause.
    base.pause = { until: Math.min(p.until, now + TIMINGS.pauseMax) };
  }
  if (Number.isFinite(data.attemptAt)) {
    // A time in the future (a clock set back) counts as now.
    base.attemptAt = Math.min(data.attemptAt, now);
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'openepaperlink.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
    /** The writes, one after the other: the last save always lands last. */
    this.queue = Promise.resolve();
    this.writes = 0;
  }

  /**
   * The saved data. An unreadable file is moved aside to `<name>.bad` and
   * `corrupted` is set, so the app says so instead of silently starting over.
   */
  async load(now = Date.now()) {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text), now);
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  /** Saves a snapshot of `data` (taken now), after the writes already queued. */
  save(data) {
    const text = JSON.stringify(data);
    const run = this.queue.then(() => this.write(text));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Resolves once every queued write ended. */
  flush() {
    return this.queue;
  }

  async write(text) {
    await mkdir(this.dir, { recursive: true });
    this.writes += 1;
    const temporary = `${this.path}.${process.pid}.${this.writes}.${randomBytes(4).toString('hex')}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load(now = Date.now()) {
    return sanitize(JSON.parse(JSON.stringify(this.data)), now);
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }

  flush() {
    return Promise.resolve();
  }
}
