// -----------------------------------------------------------------------------
// The integration: one OpenEPaperLink access point on the local network.
//
//   - the tag list is read over HTTP (`get_db`) when connecting, at most every
//     15 minutes; then the websocket of the access point (`/ws`) brings the
//     tag check-ins and the access point state as they happen;
//   - one Gladys device for the access point, one per tag (read only);
//   - the "show a text" scene action draws the text into a JPEG the size of
//     the display and sends it to `/imgupload`: one upload at a time, spaced,
//     a newer text for a tag replacing the one still waiting, never a burst;
//   - the states go to Gladys in groups, within a global budget per minute.
//
// Phases: missing (no address), invalid (not an address), connecting, ready
// (websocket open), offline (no answer), failing (unexpected answer),
// paused (429/5xx, kept in /data). index.js only wires the SDK handlers to it
// (src/handlers.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ApApi } from './ap/api.js';
import { ApError, KINDS } from './ap/errors.js';
import { httpRequest } from './ap/http.js';
import { isMac, parseMessage } from './ap/parse.js';
import { WsClient } from './ap/websocket.js';
import { normalizeConfig } from './config.js';
import {
  ALIGNMENTS,
  BACKGROUNDS,
  LIMITS,
  PATHS,
  TEXT_COLORS,
  TEXT_SIZES,
  TIMINGS,
} from './constants.js';
import { E, T } from './i18n.js';
import { encodeJpeg } from './image/jpeg.js';
import { cleanDisplayText, renderText } from './image/text.js';
import {
  HEARTBEAT_FEATURES,
  apIds,
  apStates,
  buildApDevice,
  buildTagDevice,
  tagIds,
  tagName,
  tagStates,
} from './model.js';
import { FileStore, emptyData } from './store.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const short = (value) => String(value).slice(0, 60);
const NO_ANSWER_KINDS = new Set([KINDS.UNREACHABLE, KINDS.NO_ANSWER]);

/** Colours every display has; others must be in the colour table of its type. */
const BASE_COLORS = { black: [0, 0, 0], white: [255, 255, 255] };
const DEFAULT_COLORS = { red: [255, 0, 0], yellow: [255, 255, 0] };
/** Qualities tried in turn until the JPEG fits LIMITS.imageBytes. */
const QUALITIES = [95, 85, 70];

export class OeplApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'openepaperlink' }),
    store = new FileStore(),
    request = httpRequest,
    fetchImpl,
    connectSocket,
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.request = request;
    this.fetchImpl = fetchImpl;
    this.connectSocket = connectSocket;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    this.data = undefined;
    this.started = false;
    this.generation = 0;
    this.activeFingerprint = undefined;
    this.api = undefined;
    this.ws = undefined;
    this.phase = 'idle';
    this.lastError = undefined;
    this.nextAt = undefined;
    this.failures = 0;
    this.connectedAt = undefined;
    this.lastAttemptWrite = -Infinity;
    /** The connection in flight: { generation, promise }. */
    this.connecting = undefined;
    /** The access point: { online, sys? }. */
    this.view = { online: undefined, sys: undefined };
    /** mac -> the last record of the tag (this client). */
    this.live = new Map();
    /** hwType -> display of the type (this client). */
    this.tagTypes = new Map();
    /** Device external ids created in Gladys. */
    this.createdIds = new Set();
    /** name -> timer handle, dropped by teardown(). */
    this.named = new Map();
    this.persistTimer = undefined;
    this.lastStatus = undefined;
    this.lastDevices = undefined;
    // States: what waits, what was published, the budget of the minute.
    this.pending = new Map();
    this.published = new Map();
    this.flushTimer = undefined;
    this.flushing = false;
    this.budget = { start: -Infinity, used: 0 };
    // Uploads: the queue, the one in flight, the spacing.
    this.queue = [];
    this.uploading = false;
    this.lastUploadAt = -Infinity;
    this.tagUploadAt = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The same address keeps the client, its
   * websocket and its pause: only the status, the Discovery and the states
   * the core forgot are published again. A new address starts anew.
   */
  async start(raw = {}, { connected = false } = {}) {
    await this.loadData();
    this.config = normalizeConfig(raw);
    this.started = true;
    if (connected) {
      this.lastStatus = undefined;
      this.lastDevices = undefined;
      this.published.clear();
      this.gladys.forgetPublishedStates?.();
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('publish the devices', () => this.publishDevices({ force: true }));
    if (this.config.fingerprint !== this.activeFingerprint || !this.config.ready) {
      await this.step('start the client', () => this.restart());
    }
    this.queueAllStates();
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  async loadData() {
    if (this.data) {
      return;
    }
    try {
      this.data = await this.store.load(this.now());
    } catch {
      this.data = emptyData();
    }
    if (this.store.corrupted) {
      this.logger.warn('Unreadable /data/openepaperlink.json moved to openepaperlink.json.bad');
    }
  }

  async stop() {
    this.started = false;
    this.teardown(E.notConfigured);
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.saveNow();
    }
    await this.store.flush?.().catch(() => {});
  }

  /** Ends the current client: no timer, no socket, no text kept waiting. */
  teardown(reason = 'The configuration changed: nothing sent') {
    this.generation += 1;
    for (const handle of this.named.values()) {
      this.timers.clearTimeout(handle);
    }
    this.named.clear();
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.api = undefined;
    this.connecting = undefined;
    this.live.clear();
    this.tagTypes.clear();
    for (const job of this.queue.splice(0)) {
      job.reject(new Error(reason));
    }
  }

  /** A named background timer (one per name), dropped by teardown(). */
  setNamed(name, ms, task) {
    this.clearNamed(name);
    const generation = this.generation;
    const handle = this.timers.setTimeout(
      () => {
        this.named.delete(name);
        if (generation === this.generation) {
          Promise.resolve()
            .then(task)
            .catch((err) => this.logger.warn(`Background task ${name} failed: ${err.message}`));
        }
      },
      Math.max(0, ms),
    );
    this.named.set(name, handle);
  }

  clearNamed(name) {
    if (this.named.has(name)) {
      this.timers.clearTimeout(this.named.get(name));
      this.named.delete(name);
    }
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.saveNow();
    }, this.timings.persistDelay);
  }

  saveNow() {
    return this.store
      .save(this.data)
      .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
  }

  /** Throws when the client changed meanwhile: nothing of an old reading is kept. */
  alive(generation) {
    if (generation !== this.generation) {
      throw new ApError(KINDS.STALE, 'Reading of a previous client');
    }
  }

  // --- Pauses ------------------------------------------------------------------

  pausedUntil() {
    const until = this.data?.pause?.until ?? 0;
    return until > this.now() ? until : 0;
  }

  /** A 429 or 5xx: no reading, no connection, no upload until its end (kept in /data). */
  pause(err) {
    const fallback =
      err?.kind === KINDS.RATE_LIMITED ? this.timings.pause429 : this.timings.pause5xx;
    const wanted = Number.isFinite(err?.retryAfterMs) ? err.retryAfterMs : fallback;
    const until = this.now() + clamp(wanted, this.timings.pauseMin, this.timings.pauseMax);
    if (until > this.pausedUntil()) {
      this.data.pause = { until };
      this.saveNow();
      this.logger.warn(
        `The access point answered ${err?.status ?? 'an error'}: paused until ${until}`,
      );
    }
  }

  // --- Connection ----------------------------------------------------------------

  /** A new client from the configured address. */
  async restart() {
    this.teardown();
    this.activeFingerprint = this.config.fingerprint;
    this.lastError = undefined;
    this.failures = 0;
    this.view = { online: undefined, sys: undefined };
    if (!this.config.ready) {
      this.phase = this.config.invalidHost ? 'invalid' : 'missing';
      return;
    }
    this.api = new ApApi({
      baseUrl: this.config.baseUrl,
      request: this.request,
      fetchImpl: this.fetchImpl,
      now: this.now,
      timings: this.timings,
      pausedUntil: () => this.pausedUntil(),
    });
    this.phase = 'connecting';
    this.scheduleConnect(this.now());
  }

  /**
   * The next connection attempt, never before `at`, never closer than the
   * spacing to the last attempt (kept in /data across restarts), never
   * during a pause.
   */
  scheduleConnect(at) {
    const spaced = (this.data.attemptAt ?? -Infinity) + this.timings.attemptSpacing;
    const when = Math.max(at, spaced, this.pausedUntil());
    this.nextAt = when;
    this.setNamed('connect', when - this.now(), () => this.connect());
  }

  /** The time of this attempt; written to /data at most once a minute. */
  recordAttempt() {
    const now = this.now();
    this.data.attemptAt = now;
    if (now - this.lastAttemptWrite >= this.timings.attemptWrite) {
      this.lastAttemptWrite = now;
      this.saveNow();
    }
  }

  /** One connection: shared while in flight within the same client. */
  connect() {
    const current = this.connecting;
    if (current && current.generation === this.generation) {
      return current.promise;
    }
    const entry = { generation: this.generation };
    entry.promise = this.connectOnce(entry.generation).finally(() => {
      if (this.connecting === entry) {
        this.connecting = undefined;
      }
    });
    this.connecting = entry;
    return entry.promise;
  }

  async connectOnce(generation) {
    this.clearNamed('connect');
    if (!this.api || this.ws) {
      return;
    }
    const paused = this.pausedUntil();
    if (paused) {
      this.phase = 'paused';
      this.scheduleConnect(paused);
      await this.updateStatus();
      return;
    }
    this.recordAttempt();
    try {
      if (this.resyncDue()) {
        const tags = await this.api.tags(() => this.alive(generation));
        this.alive(generation);
        // Kept in /data: a restart or "Reconnect" does not read the list again sooner.
        this.data.resync = { at: this.now(), fingerprint: this.config.fingerprint };
        this.saveNow();
        await this.keepTags(tags, generation);
      }
      this.alive(generation);
      const client = new WsClient({
        host: this.config.wsHost,
        port: this.config.wsPort,
        path: PATHS.WEBSOCKET,
        connect: this.connectSocket,
        timers: this.timers,
        timings: this.timings,
        onMessage: (text) => {
          if (this.ws === client) {
            this.message(text);
          }
        },
        onClose: (reason) => {
          if (this.ws === client) {
            this.socketClosed(reason);
          }
        },
      });
      await client.open();
      if (generation !== this.generation) {
        client.close();
        return;
      }
      this.ws = client;
      if (client.closed) {
        // Closed in the handshake turn (a close frame right after the 101):
        // a failed attempt, the next one after the backoff.
        this.ws = undefined;
        throw new ApError(KINDS.NO_ANSWER, 'Websocket closed right after the handshake');
      }
      this.connectedAt = this.now();
      if (this.phase !== 'ready') {
        this.logger.info('Connected to the access point');
      }
      this.phase = 'ready';
      this.lastError = undefined;
      this.view = { ...this.view, online: true };
      this.queueApStates();
      this.scheduleReach();
    } catch (err) {
      if (generation !== this.generation || err?.kind === KINDS.STALE) {
        return;
      }
      this.failed(err);
    }
    await this.updateStatus();
  }

  /** Whether the tag list must be read: never read for this address, or 15 minutes ago. */
  resyncDue() {
    const resync = this.data.resync;
    return (
      !resync ||
      resync.fingerprint !== this.config.fingerprint ||
      this.now() - resync.at >= this.timings.resync
    );
  }

  /** A failed attempt: the next one after the backoff (or the pause). */
  failed(err) {
    if (err?.kind === KINDS.RATE_LIMITED || err?.kind === KINDS.UNAVAILABLE) {
      this.pause(err);
    }
    this.failures += 1;
    const delays = this.timings.reconnect;
    const next = this.now() + delays[Math.min(this.failures - 1, delays.length - 1)];
    if (this.pausedUntil()) {
      this.phase = 'paused';
    } else if (NO_ANSWER_KINDS.has(err?.kind)) {
      if (this.phase !== 'offline') {
        this.logger.info(`The access point does not answer: ${err.message}`);
      }
      this.phase = 'offline';
    } else {
      const message = short(err?.message ?? String(err));
      if (this.phase !== 'failing' || this.lastError !== message) {
        this.logger.warn(`Unexpected answer of the access point: ${message}`);
      }
      this.phase = 'failing';
      this.lastError = message;
    }
    if (this.view.online !== false) {
      this.view = { ...this.view, online: false };
      this.queueApStates();
    }
    this.scheduleConnect(next);
  }

  /** The websocket ended: reconnect after the backoff (reset after a stable connection). */
  socketClosed(reason) {
    this.ws = undefined;
    this.clearNamed('reach');
    if (this.now() - (this.connectedAt ?? -Infinity) >= this.timings.stableAfter) {
      this.failures = 0;
    }
    this.failed(new ApError(KINDS.NO_ANSWER, `Websocket ended (${short(reason)})`));
    this.background(() => this.updateStatus());
  }

  /** One websocket message of the access point. */
  message(text) {
    const parsed = parseMessage(text);
    if (!parsed) {
      return;
    }
    if (parsed.type === 'sys') {
      const previous = this.view.sys ?? {};
      this.view = {
        ...this.view,
        sys: {
          apState: parsed.sys.apState ?? previous.apState,
          lowBattery: parsed.sys.lowBattery ?? previous.lowBattery,
          timeout: parsed.sys.timeout ?? previous.timeout,
        },
      };
      this.queueApStates();
    } else if (parsed.type === 'tag') {
      this.updateTag(parsed.tag);
    } else if (parsed.type === 'rebooting') {
      this.logger.info('The access point is rebooting');
      this.ws?.close();
    }
  }

  /** Every minute while connected: the "reachable" of every tag computed again. */
  scheduleReach() {
    this.setNamed('reach', 60_000, () => {
      for (const tag of this.live.values()) {
        this.queueTagStates(tag);
      }
      this.scheduleReach();
    });
  }

  // --- Tags --------------------------------------------------------------------------

  /** The whole list read over HTTP: kept, published once. */
  async keepTags(tags, generation = this.generation) {
    let changed = false;
    for (const tag of tags) {
      changed = this.remember(tag) || changed;
    }
    if (changed) {
      this.persist();
      await this.publishDevices();
      this.alive(generation);
    }
    for (const tag of tags) {
      this.queueTagStates(tag);
    }
  }

  /** One check-in from the websocket; a new tag or name republishes the Discovery, grouped. */
  updateTag(tag) {
    if (this.remember(tag)) {
      this.persist();
      this.scheduleDiscovery();
    }
    this.queueTagStates(tag);
  }

  /** One Discovery publication at most every TIMINGS.discoveryDelay for websocket changes. */
  scheduleDiscovery() {
    if (this.named.has('discovery')) {
      return;
    }
    this.setNamed('discovery', this.timings.discoveryDelay, () => this.publishDevices());
  }

  /** Keeps a tag record; true when /data changed (a new tag, a new name or type). */
  remember(tag) {
    if (!isMac(tag?.mac)) {
      return false;
    }
    const known = this.data.tags[tag.mac];
    if (!known && Object.keys(this.data.tags).length >= LIMITS.tags) {
      return false;
    }
    this.live.set(tag.mac, tag);
    const next = { mac: tag.mac, alias: tag.alias ?? null, hwType: tag.hwType ?? null };
    if (
      known &&
      known.alias === next.alias &&
      (known.hwType === next.hwType || next.hwType === null)
    ) {
      return false;
    }
    if (known && next.hwType === null) {
      next.hwType = known.hwType;
    }
    this.data.tags[tag.mac] = next;
    return true;
  }

  // --- Gladys devices -------------------------------------------------------------------

  async refreshCreated() {
    let devices;
    try {
      devices = await this.gladys.getDevices();
    } catch (err) {
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      devices = this.gladys.devices;
    }
    this.createdIds = new Set(
      (Array.isArray(devices) ? devices : [])
        .map((d) => d?.external_id)
        .filter((id) => typeof id === 'string'),
    );
  }

  /** The device Gladys has (kept up to date by the SDK). */
  createdDevice(externalId) {
    return (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
  }

  /** The Discovery tab; only when it changed, unless `force` (start, scan, connected). */
  async publishDevices({ force = false } = {}) {
    if (!this.data || !this.config.ready) {
      return;
    }
    const language = this.config.language;
    const devices = [
      buildApDevice(this.gladys, language, this.createdDevice(apIds(this.gladys).device)),
    ];
    for (const mac of Object.keys(this.data.tags).sort()) {
      const tag = this.data.tags[mac];
      devices.push(
        buildTagDevice(
          this.gladys,
          tag,
          language,
          this.createdDevice(tagIds(this.gladys, mac).device),
        ),
      );
    }
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDevices) {
      return;
    }
    await this.gladys.publishDiscoveredDevices(devices);
    this.lastDevices = key;
  }

  async deviceCreated(device) {
    const id = device?.external_id;
    if (typeof id !== 'string') {
      return;
    }
    this.createdIds.add(id);
    // The SDK forgets the values of a created or updated device: so do we.
    for (const key of [...this.published.keys()]) {
      if (key.startsWith(`${id}:`)) {
        this.published.delete(key);
      }
    }
    this.queueAllStates();
  }

  async deviceDeleted(device) {
    if (typeof device?.external_id === 'string') {
      this.createdIds.delete(device.external_id);
    }
  }

  // --- States (grouped, within a budget) ---------------------------------------------------

  queueAllStates() {
    if (!this.config.ready) {
      return;
    }
    if (this.view.online !== undefined) {
      this.queueApStates();
    }
    for (const tag of this.live.values()) {
      this.queueTagStates(tag);
    }
  }

  queueApStates() {
    const ids = apIds(this.gladys);
    this.queueStates(ids, apStates(this.view, this.config.language));
  }

  queueTagStates(tag) {
    this.queueStates(tagIds(this.gladys, tag.mac), tagStates(tag, this.now(), this.timings));
  }

  /**
   * States of a created device wait for the next flush; a value equal to the
   * one published is dropped (battery and temperature come back after the
   * heartbeat), a newer value replaces the one waiting.
   */
  queueStates(ids, list) {
    if (!this.createdIds.has(ids.device)) {
      return;
    }
    for (const { key, value } of list) {
      const id = ids.feature(key);
      const repr = typeof value === 'object' ? `t:${value.text}` : `n:${value}`;
      const previous = this.published.get(id);
      const stale =
        HEARTBEAT_FEATURES.has(key) &&
        previous &&
        this.now() - previous.at >= this.timings.heartbeat;
      if (previous && previous.repr === repr && !stale) {
        this.pending.delete(id);
        continue;
      }
      this.pending.set(id, { id, value, repr });
    }
    this.scheduleFlush(this.timings.flushInterval);
  }

  scheduleFlush(ms) {
    if (this.flushTimer || this.pending.size === 0) {
      return;
    }
    this.flushTimer = this.timers.setTimeout(
      () => {
        this.flushTimer = undefined;
        this.flush().catch((err) => this.logger.warn(`Could not publish states: ${err.message}`));
      },
      Math.max(0, ms),
    );
  }

  /**
   * Publishes what waits, one flush at a time, within the budget of states
   * per minute (all devices together); the rest waits for the next minute.
   */
  async flush() {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      while (this.pending.size > 0) {
        const now = this.now();
        if (now - this.budget.start >= 60_000) {
          this.budget = { start: now, used: 0 };
        }
        const room = this.timings.statesPerMinute - this.budget.used;
        if (room <= 0) {
          this.scheduleFlush(this.budget.start + 60_000 - now);
          return;
        }
        const batch = [...this.pending.values()].slice(0, Math.min(room, 100));
        for (const entry of batch) {
          this.pending.delete(entry.id);
        }
        this.budget.used += batch.length;
        try {
          await this.gladys.publishStates(
            batch.map(({ id, value }) =>
              typeof value === 'object'
                ? { device_feature_external_id: id, text: value.text }
                : { device_feature_external_id: id, state: value },
            ),
          );
          const at = this.now();
          for (const entry of batch) {
            this.published.set(entry.id, { repr: entry.repr, at });
          }
        } catch (err) {
          // Put back what no newer value replaced; tried again at the next flush.
          for (const entry of batch) {
            if (!this.pending.has(entry.id)) {
              this.pending.set(entry.id, entry);
            }
          }
          this.logger.warn(`Could not publish ${batch.length} state(s): ${err.message}`);
          this.scheduleFlush(this.timings.flushInterval * 6);
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // --- Scene action: show a text ----------------------------------------------------------

  /** The tag MAC of a device external id chosen in the scene, or undefined. */
  tagMac(externalId) {
    const match = /:tag:([0-9A-F]{16})$/.exec(String(externalId ?? ''));
    return match && tagIds(this.gladys, match[1]).device === externalId ? match[1] : undefined;
  }

  /**
   * "Show a text": checked at once, then queued for the access point (one
   * upload at a time, spaced; a newer text for the same tag replaces the
   * one still waiting). Resolves `{ accepted: true }` once the access point
   * took the image: the tag shows it at its next check-in.
   */
  async showText(fields = {}) {
    const started = this.now();
    if (!this.config.ready || !this.api) {
      throw new Error(E.notConfigured);
    }
    const mac = this.tagMac(fields.tag);
    if (!mac) {
      throw new Error(E.notTag);
    }
    const text = cleanDisplayText(fields.text);
    if (!text) {
      throw new Error(E.emptyText);
    }
    const option = (value, list, fallback, name) => {
      const v = value === undefined || value === null || value === '' ? fallback : String(value);
      if (!list.includes(v)) {
        throw new Error(E.badOption(name));
      }
      return v;
    };
    const ink = option(fields.color, TEXT_COLORS, 'black', 'colour');
    const paper = option(fields.background, BACKGROUNDS, 'white', 'background');
    const size = option(fields.size, TEXT_SIZES, 'auto', 'size');
    const align = option(fields.align, ALIGNMENTS, 'center', 'alignment');
    if (ink === paper) {
      throw new Error(E.sameColors);
    }
    if (this.pausedUntil()) {
      throw new Error(E.paused);
    }
    return new Promise((resolve, reject) => {
      const job = {
        mac,
        text,
        ink,
        paper,
        size,
        align,
        generation: this.generation,
        deadline: started + this.timings.sceneBudget,
        resolve,
        reject,
      };
      const index = this.queue.findIndex((j) => j.mac === mac);
      if (index >= 0) {
        this.queue[index].reject(new Error(E.replaced));
        this.queue[index] = job;
      } else if (this.queue.length >= LIMITS.queue) {
        reject(new Error(E.queueFull));
        return;
      } else {
        this.queue.push(job);
      }
      this.pump();
    });
  }

  /** When a job may start: the global spacing, its tag's spacing, a busy pause. */
  earliest(job) {
    return Math.max(
      this.lastUploadAt + this.timings.uploadSpacing,
      (this.tagUploadAt.get(job.mac) ?? -Infinity) + this.timings.tagSpacing,
      this.uploadHoldUntil(),
    );
  }

  /** Starts the next job that may start; drops those that can no longer make it. */
  pump() {
    this.clearNamed('upload');
    if (this.uploading) {
      return;
    }
    const now = this.now();
    let next;
    let wakeAt = Infinity;
    for (const job of [...this.queue]) {
      const at = this.earliest(job);
      // Not worth waiting: the job could not start before its deadline.
      if (at > job.deadline - 1_000 || this.pausedUntil()) {
        this.queue.splice(this.queue.indexOf(job), 1);
        const held = this.uploadHoldUntil();
        job.reject(new Error(this.pausedUntil() ? E.paused : held >= at ? E.held(held) : E.late));
        continue;
      }
      if (at <= now && !next) {
        next = job;
      } else {
        wakeAt = Math.min(wakeAt, at);
      }
    }
    if (next) {
      this.queue.splice(this.queue.indexOf(next), 1);
      this.uploading = true;
      this.run(next)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.uploading = false;
          this.pump();
        });
    } else if (wakeAt < Infinity) {
      this.setNamed('upload', wakeAt - now, () => this.pump());
    }
  }

  /** One text: the tag checked, the image drawn, then the upload. */
  async run(job) {
    const api = this.api;
    const left = () => job.deadline - this.now();
    const check = () => {
      if (job.generation !== this.generation || !api) {
        throw new Error('The configuration changed: nothing sent');
      }
      if (left() < 1_000) {
        throw new Error(E.late);
      }
    };
    // Spacing counts from the first request of the job, whatever its outcome.
    this.lastUploadAt = this.now();
    let tag;
    let type;
    try {
      check();
      // The tag as the access point knows it now (another access point at
      // this address, a tag removed): checked before every upload.
      tag = await api.tag(job.mac);
      check();
      if (!tag) {
        throw new Error(E.unknownTag);
      }
      if (!Number.isInteger(tag.hwType)) {
        throw new Error(E.noDisplay);
      }
      type = this.tagTypes.get(tag.hwType);
      if (!type) {
        type = await api.tagType(tag.hwType).catch((err) => {
          throw err instanceof ApError && err.kind === KINDS.BAD_RESPONSE
            ? new Error(E.noDisplay)
            : this.uploadError(err, false, true);
        });
        check();
        this.tagTypes.set(tag.hwType, type);
      }
    } catch (err) {
      throw this.uploadError(err, false);
    }
    const color = (name) => {
      if (BASE_COLORS[name]) {
        return type.colors.get(name) ?? BASE_COLORS[name];
      }
      if (!type.colors.has(name)) {
        throw new Error(E.noColor(name));
      }
      return type.colors.get(name) ?? DEFAULT_COLORS[name];
    };
    const { pixels, lines } = renderText(job.text, {
      width: type.width,
      height: type.height,
      ink: color(job.ink),
      paper: color(job.paper),
      size: job.size,
      align: job.align,
    });
    if (lines.length === 0) {
      // Not one character fits: an empty image is never announced as shown.
      throw new Error(E.tooSmall);
    }
    let jpeg;
    for (const quality of QUALITIES) {
      try {
        jpeg = encodeJpeg(pixels, type.width, type.height, {
          quality,
          maxBytes: LIMITS.imageBytes,
        });
        break;
      } catch (err) {
        if (!(err instanceof RangeError)) {
          throw err;
        }
      }
    }
    if (!jpeg) {
      throw new Error(E.tooLarge);
    }
    // The last checks right before sending: the deadline, the client, a pause.
    check();
    if (this.pausedUntil()) {
      throw new Error(E.paused);
    }
    this.lastUploadAt = this.now();
    this.tagUploadAt.set(job.mac, this.now());
    try {
      await api.upload(job.mac, jpeg, {
        timeoutMs: Math.min(this.timings.uploadTimeout, Math.max(1_000, left())),
      });
    } catch (err) {
      throw this.uploadError(err, true);
    }
    this.logger.info(`Text sent to ${tagName(this.data.tags[job.mac] ?? { mac: job.mac })}`);
    return { accepted: true };
  }

  /**
   * The error a failed text ends with; `sending`: the upload itself had
   * started; `secondary`: a display type or upload request, whose 5xx only
   * holds the uploads (the readings and the websocket go on).
   */
  uploadError(err, sending, secondary = sending) {
    if (!(err instanceof ApError)) {
      return err instanceof Error ? err : new Error(String(err));
    }
    switch (err.kind) {
      case KINDS.UNREACHABLE:
        return new Error(E.unreachable);
      case KINDS.NO_ANSWER:
        return new Error(sending ? E.unconfirmed : E.unreachable);
      case KINDS.BUSY:
        this.holdUploads(err.retryAfterMs, this.timings.busyMin);
        return new Error(E.busy);
      case KINDS.UNAVAILABLE:
        if (secondary) {
          this.holdUploads(err.retryAfterMs, this.timings.pause5xx);
          return new Error(E.failed(err.status));
        }
        this.pause(err);
        this.background(() => this.updateStatus());
        return new Error(E.failed(err.status));
      case KINDS.RATE_LIMITED:
        this.pause(err);
        this.background(() => this.updateStatus());
        return new Error(E.failed(err.status));
      case KINDS.PAUSED:
        return new Error(E.paused);
      case KINDS.HTTP:
        return new Error(E.failed(short(err.message.replace(/^The access point answered /, ''))));
      default:
        return new Error(E.failed(short(err.message)));
    }
  }

  /** The end of the hold of the uploads (409, 5xx of an upload), 0 when none. */
  uploadHoldUntil() {
    const until = this.data?.uploadHold?.until ?? 0;
    return until > this.now() ? until : 0;
  }

  /**
   * Holds the uploads (Retry-After, else `fallback`, bounded 5 s to 5 min),
   * kept in /data so a restart does not send sooner; written only when it
   * moves the end later.
   */
  holdUploads(retryAfterMs, fallback) {
    const wanted = Number.isFinite(retryAfterMs) ? retryAfterMs : fallback;
    const until = this.now() + clamp(wanted, this.timings.busyMin, this.timings.busyMax);
    if (until > this.uploadHoldUntil()) {
      this.data.uploadHold = { until };
      this.saveNow();
    }
  }

  /** A task that never holds the caller (its failure is logged). */
  background(task) {
    Promise.resolve()
      .then(task)
      .catch((err) => this.logger.warn(`Background task failed: ${err.message}`));
  }

  // --- Configuration button ------------------------------------------------------------

  /**
   * "Reconnect": a new connection at once, unless an attempt was made less
   * than the spacing ago (then the current status). The tag list is read
   * again only when its last reading is 15 minutes old (kept in /data).
   */
  async reconnect() {
    await this.loadData();
    if (!this.config.ready) {
      return this.config.invalidHost ? T.invalidHost : T.missing;
    }
    const since = this.now() - (this.data.attemptAt ?? -Infinity);
    if (since < this.timings.attemptSpacing || this.connecting) {
      return T.tooSoon(this.timings.attemptSpacing);
    }
    await this.restart();
    await this.connect();
    await this.publishDevices({ force: true }).catch(() => {});
    return this.statusMessage().message;
  }

  // --- Status ---------------------------------------------------------------------

  statusMessage() {
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    const join = (main) => {
      const all = [main, ...notes].filter(Boolean);
      return { en: all.map((n) => n.en).join(' '), fr: all.map((n) => n.fr).join(' ') };
    };
    const next = this.nextAt ?? this.now();
    switch (this.phase) {
      case 'missing':
        return { connected: false, message: join(T.missing) };
      case 'invalid':
        return { connected: false, message: join(T.invalidHost) };
      case 'paused':
        return { connected: false, message: join(T.paused(this.pausedUntil() || this.now())) };
      case 'offline':
        return { connected: false, message: join(T.offline(next)) };
      case 'failing':
        return { connected: false, message: join(T.failing(this.lastError, next)) };
      case 'ready':
        return { connected: true, message: join(T.connected(this.live.size)) };
      default:
        return { connected: false, message: join(T.connecting) };
    }
  }

  async updateStatus() {
    if (!this.started) {
      return;
    }
    const status = this.statusMessage();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
