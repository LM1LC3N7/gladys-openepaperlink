// -----------------------------------------------------------------------------
// Readers of the access point answers: types checked, values bounded, no
// prototype touched, the address normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  isMac,
  parseBaseUrl,
  parseDbPage,
  parseMessage,
  parseTag,
  parseTagType,
} from '../src/ap/parse.js';
import { PATHS } from '../src/constants.js';
import { batteryPercent, reachable } from '../src/model.js';
import { MemoryStore, sanitize } from '../src/store.js';

test('address: plain HTTP host and port only', () => {
  assert.equal(parseBaseUrl('192.168.1.30'), 'http://192.168.1.30');
  assert.equal(parseBaseUrl(' http://oepl.local:8080/ '), 'http://oepl.local:8080');
  assert.equal(parseBaseUrl('https://192.168.1.30'), undefined);
  assert.equal(parseBaseUrl('http://user:pw@192.168.1.30'), undefined);
  assert.equal(parseBaseUrl('192.168.1.30/admin'), undefined);
  assert.equal(parseBaseUrl('192.168.1.30?x=1'), undefined);
  assert.equal(parseBaseUrl('a b'), undefined);
  const config = normalizeConfig({ host: '[fe80::1]:81' });
  assert.equal(config.wsHost, 'fe80::1');
  assert.equal(config.wsPort, 81);
  assert.equal(normalizeConfig({ host: 'ftp://x' }).invalidHost, true);
});

test('tags: MAC checked, values typed and bounded', () => {
  assert.equal(isMac('A1B2C3D4E5F60001'), true);
  assert.equal(isMac('a1b2c3d4e5f60001'), false);
  assert.equal(isMac('__proto__'), false);
  const tag = parseTag({
    mac: 'A1B2C3D4E5F60001',
    alias: 'Cuisine\u0000\n',
    hwType: 1,
    lastseen: 1_790_000_000,
    nextcheckin: 12,
    batteryMv: -5,
    temperature: 'hot',
    isexternal: 1,
  });
  assert.deepEqual(tag, {
    mac: 'A1B2C3D4E5F60001',
    alias: 'Cuisine',
    hwType: 1,
    lastSeen: 1_790_000_000,
    nextCheckin: undefined,
    batteryMv: undefined,
    temperature: undefined,
    external: true,
  });
  assert.equal(parseTag({ mac: 'zz' }), undefined);
  assert.equal(parseTag(null), undefined);
});

test('tag list: pages, hostile entries dropped, no prototype polluted', () => {
  const page = parseDbPage(
    JSON.parse(
      '{"tags":[{"mac":"__proto__"},{"mac":"A1B2C3D4E5F60001","__proto__":{"polluted":1}},7],"continu":5}',
    ),
  );
  assert.equal(page.tags.length, 1);
  assert.equal(page.next, 5);
  assert.equal({}.polluted, undefined);
  assert.equal(parseDbPage({ tags: 'no' }), undefined);
});

test('messages: sys, one tag, rebooting, anything else ignored', () => {
  assert.deepEqual(parseMessage('{"sys":{"apstate":1,"lowbattcount":2}}'), {
    type: 'sys',
    sys: { apState: 1, lowBattery: 2, timeout: undefined },
  });
  assert.equal(parseMessage('{"tags":[{"mac":"A1B2C3D4E5F60001"}]}').type, 'tag');
  assert.deepEqual(parseMessage('{"errMsg":"REBOOTING"}'), { type: 'rebooting' });
  assert.equal(parseMessage('{"logMsg":"x"}'), undefined);
  assert.equal(parseMessage('{"tags":[]}'), undefined);
  assert.equal(parseMessage('not json'), undefined);
});

test('tag types: size bounded, colours checked', () => {
  const type = parseTagType({
    width: 296,
    height: 128,
    colortable: {
      white: [255, 255, 255],
      red: [255, 0, 0],
      __proto__: [1, 2, 3],
      bad: [300, 0, 0],
    },
  });
  assert.equal(type.width, 296);
  assert.deepEqual([...type.colors.keys()].sort(), ['red', 'white']);
  assert.equal(parseTagType({ width: 0, height: 0 }), undefined);
  assert.equal(parseTagType({ width: 2000, height: 2000 }), undefined);
  assert.equal(PATHS.tagType(1), '/tagtypes/01.json');
  assert.equal(PATHS.tagType(0x1234), '/tagtypes/1234.json');
});

test('battery and reachability as the reference computes them', () => {
  assert.equal(batteryPercent(2200), 0);
  assert.equal(batteryPercent(2400), 50);
  assert.equal(batteryPercent(3000), 100);
  assert.equal(batteryPercent(0), undefined);
  const timings = { checkinGrace: 600_000, seenRecently: 3_600_000 };
  assert.equal(reachable({ nextCheckin: 100 }, 100_000 + 600_000, timings), true);
  assert.equal(reachable({ nextCheckin: 100 }, 100_000 + 600_001, timings), false);
  assert.equal(reachable({ lastSeen: 100 }, 100_000 + 3_600_001, timings), false);
  assert.equal(reachable({}, 0, timings), undefined);
});

test('/data: checked field by field, bounded times, no prototype', async () => {
  const now = Date.UTC(2026, 9, 18);
  const data = sanitize(
    JSON.parse(
      '{"tags":{"__proto__":{"mac":"__proto__"},"A1B2C3D4E5F60001":{"mac":"A1B2C3D4E5F60001","alias":"x","hwType":1},"BAD":{}},"pause":{"until":9e15},"attemptAt":9e15,"secret":"no"}',
    ),
    now,
  );
  assert.deepEqual(Object.keys(data.tags), ['A1B2C3D4E5F60001']);
  assert.equal(Object.getPrototypeOf(data.tags), null);
  assert.ok(data.pause.until <= now + 6 * 3_600_000);
  assert.equal(data.attemptAt, now);
  assert.equal('secret' in data, false);
  const store = new MemoryStore();
  await store.save(data);
  assert.deepEqual(await store.load(now), data);
});
