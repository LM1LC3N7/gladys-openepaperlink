// -----------------------------------------------------------------------------
// OeplApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store, a fake access point (fetch + websocket)
// and a clock the tests move by hand. No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OeplApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { fakeClock } from './helpers/fakeClock.js';
import { DESK, HOST, KITCHEN, fakeAp, serverFrame, tagRecord } from './helpers/fakeAp.js';

const SELECTOR = 'openepaperlink';
const CONFIG = { host: HOST };
const apId = (key) => `ext:${SELECTOR}:ap:main${key ? `:${key}` : ''}`;
const tagId = (mac, key) => `ext:${SELECTOR}:tag:${mac}${key ? `:${key}` : ''}`;
const MINUTE = 60_000;

async function setup(
  t,
  {
    config = CONFIG,
    store = new MemoryStore(),
    clock = fakeClock(),
    ap = fakeAp(),
    timings = TIMINGS,
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new OeplApp({
    gladys,
    logger,
    store,
    fetchImpl: ap.fetch,
    connectSocket: ap.connect,
    now: clock.now,
    timers: clock.timers,
    timings,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await clock.advance(0);
  t.after(() => app.stop());
  return { gladys, app, ap, clock, store, logs };
}

async function create(gladys, clock, externalId) {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  assert.ok(device, `${externalId} is in the Discovery tab`);
  gladys.fake.devices.push(device);
  await gladys.fake.deviceCreated(device);
  await clock.settle();
  return device;
}

async function createdAll(t, options) {
  const env = await setup(t, options);
  await create(env.gladys, env.clock, apId());
  await create(env.gladys, env.clock, tagId(KITCHEN));
  await create(env.gladys, env.clock, tagId(DESK));
  await env.clock.advance(TIMINGS.flushInterval);
  return env;
}

const show = (gladys, fields) => gladys.fake.sceneAction('show_text', fields);

test('discovery: the access point and one device per tag, read only, core units', async (t) => {
  const { gladys, ap } = await setup(t);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [apId(), tagId(KITCHEN), tagId(DESK)],
  );
  const kitchen = devices[1];
  assert.equal(kitchen.name, 'Cuisine');
  assert.equal(devices[2].name, `OpenEPaperLink ${DESK}`);
  const byKey = Object.fromEntries(kitchen.features.map((f) => [f.external_id, f]));
  assert.deepEqual(
    [byKey[tagId(KITCHEN, 'battery')].category, byKey[tagId(KITCHEN, 'battery')].unit],
    ['battery', 'percent'],
  );
  assert.deepEqual(
    [
      byKey[tagId(KITCHEN, 'temperature')].category,
      byKey[tagId(KITCHEN, 'temperature')].type,
      byKey[tagId(KITCHEN, 'temperature')].unit,
    ],
    ['device-temperature-sensor', 'decimal', 'celsius'],
  );
  for (const device of devices) {
    for (const f of device.features) {
      assert.equal(f.read_only, true, f.external_id);
      assert.notEqual(f.category, 'switch');
      assert.ok([undefined, 'percent', 'celsius'].includes(f.unit), f.external_id);
    }
  }
  assert.equal(ap.count('/get_db'), 1);
  assert.equal(ap.sockets.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /2 tags/);
});

test('states: tag and access point values once created, unchanged values not sent again', async (t) => {
  const { gladys, ap, clock } = await createdAll(t);
  assert.equal(gladys.fake.lastState(tagId(KITCHEN, 'battery')), 100);
  assert.equal(gladys.fake.lastState(tagId(KITCHEN, 'temperature')), 21);
  assert.equal(gladys.fake.lastState(tagId(KITCHEN, 'reachable')), 1);
  assert.equal(gladys.fake.lastState(tagId(KITCHEN, 'last_seen')), '2026-10-18 11:59 UTC');
  assert.equal(gladys.fake.lastState(apId('online')), 1);
  const before = gladys.fake.states.length;
  ap.push({ sys: { apstate: 1, lowbattcount: 0, timeoutcount: 1, heap: 1234 } });
  ap.push({ tags: [tagRecord(KITCHEN, { batteryMv: 2400, temperature: 19.46 })] });
  await clock.advance(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(apId('state')), 'En ligne');
  assert.equal(gladys.fake.lastState(apId('timeout_tags')), 1);
  assert.equal(gladys.fake.lastState(tagId(KITCHEN, 'battery')), 50);
  assert.equal(gladys.fake.lastState(tagId(KITCHEN, 'temperature')), 19.5);
  const after = gladys.fake.states.length;
  // The same messages again: nothing new is sent.
  ap.push({ sys: { apstate: 1, heap: 999 } });
  ap.push({ tags: [tagRecord(KITCHEN, { batteryMv: 2400, temperature: 19.46 })] });
  await clock.advance(TIMINGS.flushInterval);
  assert.equal(gladys.fake.states.length, after);
  assert.ok(after > before);
});

test('states: a tag overdue becomes unreachable without any message', async (t) => {
  const { gladys, clock } = await createdAll(t);
  assert.equal(gladys.fake.lastState(tagId(DESK, 'reachable')), 1);
  await clock.advance(12 * MINUTE);
  assert.equal(gladys.fake.lastState(tagId(DESK, 'reachable')), 0);
});

test('states: never more than the budget per minute, the rest follows', async (t) => {
  const ap = fakeAp();
  ap.tags = Array.from({ length: 100 }, (_, i) =>
    tagRecord(`A1B2C3D4E5F6${String(i).padStart(4, '0')}`),
  );
  const { gladys, clock } = await setup(t, { ap });
  for (const device of gladys.fake.discoveredDevices) {
    gladys.fake.devices.push(device);
    await gladys.fake.deviceCreated(device);
  }
  await clock.advance(TIMINGS.flushInterval);
  // 100 tags x 4 states + the access point: more than one minute of budget.
  assert.ok(gladys.fake.states.length <= TIMINGS.statesPerMinute);
  await clock.advance(MINUTE);
  assert.ok(gladys.fake.states.length >= 400);
  assert.ok(gladys.fake.states.length <= 2 * TIMINGS.statesPerMinute);
});

test('connected again: status and Discovery republished, no new reading nor connection', async (t) => {
  const { gladys, ap, clock } = await createdAll(t);
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.requests.filter((r) => /discover/.test(r.path)).length;
  const reads = ap.requests.length;
  await gladys.disconnect();
  await gladys.connect();
  await clock.advance(0);
  // A configuration saved unchanged: nothing read either.
  await gladys.fake.configUpdated(CONFIG);
  await clock.advance(0);
  assert.equal(ap.requests.length, reads, 'no HTTP request');
  assert.equal(ap.sockets.length, 1, 'the same websocket');
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'status published again');
  assert.ok(
    gladys.fake.requests.filter((r) => /discover/.test(r.path)).length > discoveries,
    'Discovery published again',
  );
});

test('restart of the container: no connection closer than the spacing to the last attempt', async (t) => {
  const clock = fakeClock();
  const store = new MemoryStore({ ...emptyData(), attemptAt: clock.now() - 2_000 });
  const { ap } = await setup(t, { store, clock });
  assert.equal(ap.requests.length, 0);
  await clock.advance(TIMINGS.attemptSpacing - 2_000 - 1);
  assert.equal(ap.requests.length, 0);
  await clock.advance(1);
  assert.equal(ap.count('/get_db'), 1);
  assert.ok(store.data.attemptAt >= clock.now() - 1);
});

test('access point down: retries spaced by the backoff, never faster', async (t) => {
  const ap = fakeAp();
  ap.mode = 'down';
  const { gladys, clock } = await setup(t, { ap });
  assert.equal(ap.count('/get_db'), 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer/);
  await clock.advance(TIMINGS.reconnect[0] - 1);
  assert.equal(ap.count('/get_db'), 1);
  await clock.advance(1);
  assert.equal(ap.count('/get_db'), 2);
  await clock.advance(TIMINGS.reconnect[1]);
  assert.equal(ap.count('/get_db'), 3);
  // "Reconnect" right after an attempt: no new attempt.
  await clock.advance(1_000);
  const ack = await gladys.fake.action('reconnect');
  assert.match(ack.data.message.en, /less than/);
  assert.equal(ap.count('/get_db'), 3);
});

test('websocket dropped: reconnects after the backoff, the tag list is not read again', async (t) => {
  const { gladys, ap, clock } = await createdAll(t);
  assert.equal(gladys.fake.lastState(apId('online')), 1);
  ap.socket().destroy();
  await clock.advance(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(apId('online')), 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await clock.advance(TIMINGS.reconnect[0]);
  assert.equal(ap.sockets.length, 2);
  assert.equal(ap.count('/get_db'), 1, 'resync only every 15 minutes');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('websocket: an oversized or masked frame closes the connection, the app reconnects later', async (t) => {
  const { ap, clock, logs } = await createdAll(t);
  const huge = Buffer.alloc(10);
  huge[0] = 0x81;
  huge[1] = 127;
  huge.writeBigUInt64BE(10n ** 12n, 2);
  ap.push(huge);
  await clock.settle();
  assert.equal(ap.sockets[0].destroyed, true);
  assert.ok(logs.some((l) => /does not answer|Websocket/.test(l)));
  await clock.advance(TIMINGS.reconnect[0]);
  assert.equal(ap.sockets.length, 2);
  // A masked frame from the server is a protocol error too.
  ap.push(Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x41]));
  await clock.settle();
  assert.equal(ap.sockets[1].destroyed, true);
});

test('websocket: hostile JSON never pollutes a prototype nor adds a tag', async (t) => {
  const { gladys, ap, clock } = await createdAll(t);
  ap.push('{"tags":[{"mac":"__proto__","alias":"x"}]}');
  ap.push('{"__proto__":{"polluted":1},"tags":[{"mac":"A1B2C3D4E5F60001","__proto__":{"x":1}}]}');
  ap.push('not json');
  ap.push(serverFrame('{"sys":', 1));
  await clock.advance(TIMINGS.flushInterval);
  assert.equal({}.polluted, undefined);
  assert.equal(gladys.fake.discoveredDevices.length, 3);
});

test('access point rebooting: closed at once, reconnected after the backoff', async (t) => {
  const { ap, clock } = await createdAll(t);
  ap.push({ errMsg: 'REBOOTING' });
  await clock.settle();
  assert.equal(ap.sockets[0].destroyed, true);
  await clock.advance(TIMINGS.reconnect[0]);
  assert.equal(ap.sockets.length, 2);
});

test('5xx on the tag list: a pause kept in /data, nothing asked before its end', async (t) => {
  const ap = fakeAp();
  ap.statuses.set('/get_db', 503);
  ap.retryAfter.set('/get_db', '120');
  const { gladys, clock, store } = await setup(t, { ap });
  assert.equal(store.data.pause.until, clock.now() + 120_000);
  assert.match(gladys.fake.connectionStatus.message.en, /paused/);
  await clock.advance(119_000);
  assert.equal(ap.count('/get_db'), 1);
  ap.statuses.clear();
  await clock.advance(1_000);
  assert.equal(ap.count('/get_db'), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a reading of an old address publishes nothing and sets no status', async (t) => {
  const ap = fakeAp();
  ap.hang.add('/get_db');
  const timings = { ...TIMINGS, httpTimeout: 200 };
  const { gladys, clock } = await setup(t, { ap, timings });
  ap.hang.clear();
  ap.tags = [tagRecord(DESK)];
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.fake.configUpdated({ host: '192.168.1.31' });
  await clock.advance(TIMINGS.attemptSpacing);
  // The old request ends (timeout) after the new client connected.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await clock.settle();
  const last = gladys.fake.connectionStatus;
  assert.equal(last.connected, true);
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.ok(
    !gladys.fake.connectionStatuses
      .slice(statuses)
      .some((s) => /does not answer/.test(s.message.en)),
  );
});

test('show a text: the tag checked, a JPEG of the display size, mac before the file', async (t) => {
  const { gladys, ap } = await createdAll(t);
  const ack = await show(gladys, {
    tag: tagId(KITCHEN),
    text: 'Bonjour à tous\nCafé',
    color: 'red',
  });
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(ack.data.outputs, { accepted: true });
  assert.equal(ap.uploads.length, 1);
  const [upload] = ap.uploads;
  assert.equal(upload.mac, KITCHEN);
  assert.equal(upload.macFirst, true);
  assert.equal(upload.dither, '0');
  assert.deepEqual([...upload.jpeg.subarray(0, 2)], [0xff, 0xd8]);
  const sof = upload.jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(upload.jpeg.readUInt16BE(sof + 5), 128);
  assert.equal(upload.jpeg.readUInt16BE(sof + 7), 296);
  const order = ap.requests.slice(-3).map((r) => r.path);
  assert.deepEqual(order, ['/get_db', '/tagtypes/01.json', '/imgupload']);
  assert.equal(ap.requests.at(-3).query, `?mac=${KITCHEN}`);
});

test('show a text: refused before anything is sent when it cannot be shown', async (t) => {
  const { gladys, ap, clock } = await createdAll(t);
  const cases = [
    [{ tag: apId(), text: 'x' }, /not the access point/],
    [{ tag: 'ext:other:tag:A1B2C3D4E5F60001', text: 'x' }, /not the access point/],
    [{ tag: tagId(KITCHEN), text: '  \u0000\u{200b} ' }, /empty/],
    [{ tag: tagId(KITCHEN), text: 'x', color: 'blue' }, /Unknown colour/],
    [{ tag: tagId(KITCHEN), text: 'x', color: 'white', background: 'white' }, /same colour/],
  ];
  for (const [fields, message] of cases) {
    const ack = await show(gladys, fields);
    assert.equal(ack.success, false, JSON.stringify(fields));
    assert.match(ack.error, message);
  }
  assert.equal(ap.uploads.length, 0);
  assert.equal(ap.requests.filter((r) => r.query?.includes('mac=')).length, 0);
  // Red on a black and white display, a tag the access point does not know:
  // asked to the access point (spaced like any upload), nothing uploaded.
  const red = await show(gladys, { tag: tagId(DESK), text: 'x', color: 'red' });
  assert.match(red.error, /has no red/);
  ap.tags = [tagRecord(KITCHEN)];
  const gone = show(gladys, { tag: tagId(DESK), text: 'x' });
  await clock.advance(TIMINGS.uploadSpacing);
  assert.match((await gone).error, /does not know this tag/);
  assert.equal(ap.uploads.length, 0);
});

test('show a text: never a burst, a newer text for a tag replaces the one waiting', async (t) => {
  const { gladys, ap, clock } = await createdAll(t);
  const first = show(gladys, { tag: tagId(KITCHEN), text: 'one' });
  await clock.settle();
  assert.equal(ap.uploads.length, 1);
  // Same tag: waits its 15 s; a newer one replaces it before it leaves.
  const second = show(gladys, { tag: tagId(KITCHEN), text: 'two' });
  const third = show(gladys, { tag: tagId(KITCHEN), text: 'three' });
  // Another tag: waits the 2 s between any two uploads.
  const other = show(gladys, { tag: tagId(DESK), text: 'desk' });
  await clock.settle();
  assert.equal(ap.uploads.length, 1);
  await clock.advance(TIMINGS.uploadSpacing - 1);
  assert.equal(ap.uploads.length, 1);
  await clock.advance(1);
  assert.equal(ap.uploads.length, 2);
  assert.equal(ap.uploads[1].mac, DESK);
  await clock.advance(TIMINGS.tagSpacing);
  assert.equal(ap.uploads.length, 3);
  assert.equal((await first).success, true);
  assert.match((await second).error, /Replaced by a newer text/);
  assert.equal((await third).success, true);
  assert.equal((await other).success, true);
});

test('show a text: a full queue refuses at once, a text that would leave late is dropped', async (t) => {
  const ap = fakeAp();
  ap.tags = Array.from({ length: 12 }, (_, i) =>
    tagRecord(`A1B2C3D4E5F6${String(i).padStart(4, '0')}`, { hwType: 0 }),
  );
  const timings = { ...TIMINGS, sceneBudget: 9_000 };
  const { gladys, clock } = await setup(t, { ap, timings });
  const acks = ap.tags.map((tag) => show(gladys, { tag: tagId(tag.mac), text: 'x' }));
  await clock.settle();
  // One in flight, ten waiting: the twelfth is refused at once.
  const settled = await Promise.race([acks[11], new Promise((r) => setTimeout(r, 50, 'pending'))]);
  assert.notEqual(settled, 'pending');
  assert.match(settled.error, /Too many texts/);
  await clock.advance(30_000);
  const results = await Promise.all(acks);
  // 2 s apart within a 9 s budget: five leave (0, 2, 4, 6, 8 s), the others
  // are dropped without being sent.
  assert.equal(ap.uploads.length, 5);
  assert.equal(results.filter((r) => r.success).length, 5);
  assert.equal(results.filter((r) => /No time left/.test(r.error ?? '')).length, 6);
});

test('show a text: 409 busy pauses the uploads, a timeout is "sent, without confirmation"', async (t) => {
  const timings = { ...TIMINGS, uploadTimeout: 100 };
  const { gladys, ap, clock } = await createdAll(t, { timings });
  ap.statuses.set('/imgupload', 409);
  ap.retryAfter.set('/imgupload', '20');
  const busy = await show(gladys, { tag: tagId(KITCHEN), text: 'x' });
  assert.match(busy.error, /busy/);
  ap.statuses.clear();
  const next = show(gladys, { tag: tagId(DESK), text: 'y' });
  await clock.settle();
  const uploads = ap.requests.filter((r) => r.path === '/imgupload').length;
  await clock.advance(19_000);
  assert.equal(ap.requests.filter((r) => r.path === '/imgupload').length, uploads);
  await clock.advance(1_000);
  assert.equal((await next).success, true);
  ap.hang.add('/imgupload');
  await clock.advance(TIMINGS.tagSpacing);
  const slow = show(gladys, { tag: tagId(KITCHEN), text: 'z' });
  await clock.settle();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match((await slow).error, /sent, without confirmation/);
});

test('show a text: a 5xx of the upload pauses everything, kept in /data', async (t) => {
  const { gladys, ap, store, clock } = await createdAll(t);
  ap.statuses.set('/imgupload', 500);
  const failed = await show(gladys, { tag: tagId(KITCHEN), text: 'x' });
  assert.match(failed.error, /refused the text \(500\)/);
  assert.equal(store.data.pause.until, clock.now() + TIMINGS.pause5xx);
  const paused = await show(gladys, { tag: tagId(DESK), text: 'y' });
  assert.match(paused.error, /slow down/);
});

test('nothing in /data but tags, the pause and the attempt time', async (t) => {
  const { store, clock } = await createdAll(t);
  await clock.advance(2_000);
  assert.deepEqual(Object.keys(store.data).sort(), ['attemptAt', 'pause', 'tags']);
  assert.deepEqual(Object.keys(store.data.tags).sort(), [KITCHEN, DESK].sort());
  assert.deepEqual(store.data.tags[KITCHEN], { mac: KITCHEN, alias: 'Cuisine', hwType: 1 });
});
