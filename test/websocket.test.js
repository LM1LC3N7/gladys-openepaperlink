// -----------------------------------------------------------------------------
// The websocket client against a real local TCP server (127.0.0.1, random
// port) that plays the access point: handshake, messages split in 1-byte
// chunks, fragments, ping, and the bounds that close the connection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { FrameParser, WsClient, acceptFor, encodeFrame } from '../src/ap/websocket.js';
import { serverFrame } from './helpers/fakeAp.js';
import { fakeClock } from './helpers/fakeClock.js';

/** A server: `onClient(socket, frames)` once the handshake is answered. */
async function server(t, { accept = true, onClient = () => {} } = {}) {
  const sockets = [];
  const srv = createServer((socket) => {
    sockets.push(socket);
    let head = '';
    let upgraded = false;
    const received = [];
    socket.on('data', (chunk) => {
      if (upgraded) {
        // Client frames are masked: header 2 bytes, mask 4 bytes (small frames only here).
        const length = chunk[1] & 0x7f;
        const mask = chunk.subarray(2, 6);
        const payload = Buffer.from(chunk.subarray(6, 6 + length).map((b, i) => b ^ mask[i & 3]));
        received.push({ opcode: chunk[0] & 0x0f, payload });
        return;
      }
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) {
        return;
      }
      const key = head.match(/Sec-WebSocket-Key: (\S+)/)[1];
      upgraded = true;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept ? acceptFor(key) : 'wrong'}\r\n\r\n`,
      );
      onClient(socket, received);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const s of sockets) {
      s.destroy();
    }
    srv.close();
  });
  return { port: srv.address().port };
}

const client = (port, extra = {}) => {
  const messages = [];
  const closes = [];
  const ws = new WsClient({
    host: '127.0.0.1',
    port,
    onMessage: (m) => messages.push(m),
    onClose: (r) => closes.push(r),
    ...extra,
  });
  return { ws, messages, closes };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out');
    }
    await wait(5);
  }
}

test('handshake, then messages even split byte by byte, and fragments', async (t) => {
  const { port } = await server(t, {
    onClient: async (socket) => {
      const frame = serverFrame(JSON.stringify({ sys: { apstate: 1 } }));
      for (const byte of frame) {
        socket.write(Buffer.from([byte]));
        await wait(0);
      }
      // A message in two fragments: TEXT without FIN, then CONTINUATION with FIN.
      socket.write(Buffer.concat([Buffer.from([0x01, 3]), Buffer.from('{"a')]));
      socket.write(Buffer.concat([Buffer.from([0x80, 4]), Buffer.from('":1}')]));
    },
  });
  const { ws, messages } = client(port);
  t.after(() => ws.close());
  await ws.open();
  await until(() => messages.length === 2);
  assert.deepEqual(messages, ['{"sys":{"apstate":1}}', '{"a":1}']);
});

test('a ping is answered by a pong, our frames are masked', async (t) => {
  let frames;
  const { port } = await server(t, {
    onClient: (socket, received) => {
      frames = received;
      socket.write(Buffer.from([0x89, 2, 0x68, 0x69]));
    },
  });
  const { ws } = client(port);
  t.after(() => ws.close());
  await ws.open();
  await until(() => frames?.some((f) => f.opcode === 0x0a));
  assert.equal(frames.find((f) => f.opcode === 0x0a).payload.toString(), 'hi');
  const frame = encodeFrame(1, Buffer.from('x'), Buffer.from([1, 2, 3, 4]));
  assert.equal(frame[1] & 0x80, 0x80, 'masked');
});

test('a wrong Sec-WebSocket-Accept fails the handshake', async (t) => {
  const { port } = await server(t, { accept: false });
  const { ws, closes } = client(port);
  await assert.rejects(ws.open(), /not acknowledged/);
  assert.equal(closes.length, 1);
});

test('an announced frame over the bound closes before reading it', async (t) => {
  const { port } = await server(t, {
    onClient: (socket) => {
      const header = Buffer.from([0x81, 126, 0xff, 0xff]);
      socket.write(header);
    },
  });
  const { ws, closes, messages } = client(port, { maxMessage: 1024 });
  await ws.open();
  await until(() => closes.length === 1);
  assert.equal(messages.length, 0);
  assert.equal(ws.closed, true);
});

test('fragments over the bound in all close the connection', async (t) => {
  const { port } = await server(t, {
    onClient: (socket) => {
      const part = Buffer.alloc(100, 0x61);
      socket.write(Buffer.concat([Buffer.from([0x01, 100]), part]));
      for (let i = 0; i < 20; i += 1) {
        socket.write(Buffer.concat([Buffer.from([0x00, 100]), part]));
      }
    },
  });
  const { ws, closes, messages } = client(port, { maxMessage: 1024 });
  await ws.open();
  await until(() => closes.length === 1);
  assert.equal(messages.length, 0);
});

test('nothing listening: unreachable', async () => {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  const { ws } = client(port);
  await assert.rejects(ws.open(), (err) => err.kind === 'unreachable');
});

test('the frame parser is linear: a large frame in 1-byte chunks is copied once', () => {
  const frames = [];
  const parser = new FrameParser({ onFrame: (f) => frames.push(f) });
  const frame = serverFrame('x'.repeat(60_000));
  const started = process.hrtime.bigint();
  for (let i = 0; i < frame.length; i += 1) {
    parser.push(frame.subarray(i, i + 1));
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 60_000);
  assert.ok(ms < 2_000, `${ms} ms`);
});

test('the frame parser refuses reserved bits, masks and long control frames', () => {
  const parse = (bytes) => new FrameParser({ onFrame: () => {} }).push(Buffer.from(bytes));
  assert.throws(() => parse([0xc1, 0]), /reserved/);
  assert.throws(() => parse([0x81, 0x80, 0, 0, 0, 0]), /Masked/);
  assert.throws(() => parse([0x89, 126, 0, 200]), /control/);
  assert.throws(() => parse([0x09, 0]), /control/);
});

/** A fake socket answering the handshake with `answer(key)`; returns { socket, ws, opened }. */
function fakeHandshake(answer, extra = {}) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writableLength = 0;
  socket.setNoDelay = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.write = (data) => {
    const key = Buffer.from(data)
      .toString('latin1')
      .match(/Sec-WebSocket-Key: (\S+)/)?.[1];
    if (key) {
      setImmediate(() => socket.emit('data', answer(key)));
    }
  };
  const ws = new WsClient({ host: 'x', connect: () => socket, ...extra });
  const opened = ws.open().then(
    () => 'open',
    (e) => e.message,
  );
  setImmediate(() => socket.emit('connect'));
  return { socket, ws, opened };
}

const ok101 = (key, more = '') =>
  Buffer.from(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n${more}\r\n`,
  );

test('I3 a 101 followed by a 10 KB first message in one chunk: open, the message read', async (t) => {
  const messages = [];
  const big = JSON.stringify({
    tags: [{ mac: 'A1B2C3D4E5F60001', modecfgjson: 'x'.repeat(10_000) }],
  });
  const { ws, opened } = fakeHandshake((key) => Buffer.concat([ok101(key), serverFrame(big)]), {
    onMessage: (m) => messages.push(m),
  });
  t.after(() => ws.end('test'));
  assert.equal(await opened, 'open');
  await until(() => messages.length === 1);
  assert.equal(messages[0], big);
});

test('I3 headers longer than the bound, even byte by byte: refused, linear', async () => {
  const socket = new EventEmitter();
  socket.setNoDelay = () => {};
  socket.destroy = () => {};
  socket.write = () => {};
  const ws = new WsClient({ host: 'x', connect: () => socket });
  const opened = ws.open().catch((e) => e.message);
  socket.emit('connect');
  const started = process.hrtime.bigint();
  for (let i = 0; i <= 8 * 1024; i += 1) {
    socket.emit('data', Buffer.from('X'));
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.match(await opened, /too long/);
  assert.ok(ms < 500, `${ms} ms`);
});

test('M7 the handshake must upgrade to websocket, without extension nor subprotocol', async () => {
  const cases = [
    [
      (k) => Buffer.from(`HTTP/1.1 101 OK\r\nSec-WebSocket-Accept: ${acceptFor(k)}\r\n\r\n`),
      /Upgrade/,
    ],
    [
      (k) =>
        Buffer.from(
          `HTTP/1.1 101 OK\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptFor(k)}\r\n\r\n`,
        ),
      /Connection/,
    ],
    [(k) => ok101(k, 'Sec-WebSocket-Extensions: permessage-deflate\r\n'), /extension/],
    [(k) => ok101(k, 'Sec-WebSocket-Protocol: chat\r\n'), /subprotocol/],
  ];
  for (const [answer, message] of cases) {
    const { opened } = fakeHandshake(answer);
    assert.match(await opened, message);
  }
});

test('M7 text that is not UTF-8 and a close frame of one byte are protocol errors', async (t) => {
  for (const frame of [Buffer.from([0x81, 2, 0xc3, 0x28]), Buffer.from([0x88, 1, 0x03])]) {
    const messages = [];
    const closes = [];
    const { ws, socket, opened } = fakeHandshake(ok101, {
      onMessage: (m) => messages.push(m),
      onClose: (r) => closes.push(r),
    });
    t.after(() => ws.end('test'));
    assert.equal(await opened, 'open');
    await wait(5);
    socket.emit('data', frame);
    assert.equal(messages.length, 0);
    assert.equal(closes.length, 1);
    assert.match(closes[0], /UTF-8|one byte/);
  }
});

test('M1 a frame dripped one byte at a time: closed 30 s after its first byte', async () => {
  const clock = fakeClock();
  const closes = [];
  const { ws, socket, opened } = fakeHandshake(ok101, {
    timers: clock.timers,
    onClose: (r) => closes.push(r),
  });
  assert.equal(await opened, 'open');
  await clock.settle();
  socket.emit('data', Buffer.from([0x81, 126, 0xff, 0x00]));
  for (let i = 0; i < 5 && !ws.closed; i += 1) {
    await clock.advance(8_000);
    socket.emit('data', Buffer.from([0x20]));
  }
  assert.equal(ws.closed, true);
  assert.match(closes[0], /not completed in time/);
});

test('I2 a ping flood: at most 100 pings in a row, one pong waiting at most', async () => {
  const closes = [];
  const { ws, socket, opened } = fakeHandshake(ok101, { onClose: (r) => closes.push(r) });
  assert.equal(await opened, 'open');
  await wait(5);
  const writes = [];
  socket.write = (data, callback) => {
    writes.push({ data, callback });
  };
  const ping = Buffer.from([0x89, 0]);
  socket.emit('data', Buffer.concat(Array(50).fill(ping)));
  assert.equal(writes.length, 1, 'one pong waiting, the next pings wait for it');
  writes[0].callback();
  socket.emit('data', Buffer.concat(Array(60).fill(ping)));
  assert.equal(ws.closed, true);
  assert.match(closes[0], /Too many websocket pings/);
});

test('I2 a peer that does not read: closed past 64 KB waiting, nothing more written', async (t) => {
  let serverSocket;
  const srv = createServer((socket) => {
    serverSocket = socket;
    let head = '';
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) {
        return;
      }
      const key = head.match(/Sec-WebSocket-Key: (\S+)/)[1];
      socket.removeAllListeners('data');
      socket.write(ok101(key));
      socket.pause();
      // Pings with the largest payload, many times, mixed with text frames so
      // the "in a row" bound is not what closes it.
      const ping = Buffer.concat([Buffer.from([0x89, 125]), Buffer.alloc(125, 0x41)]);
      const text = serverFrame('{}');
      const burst = Buffer.concat(Array(4_000).fill(Buffer.concat([ping, text])));
      let sent = 0;
      const pump = () => {
        while (sent < 40 && socket.write(burst)) {
          sent += 1;
        }
        if (sent < 40) {
          socket.once('drain', pump);
        }
      };
      setTimeout(pump, 20);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    serverSocket?.destroy();
    srv.close();
  });
  const ws = new WsClient({ host: '127.0.0.1', port: srv.address().port });
  t.after(() => ws.end('test'));
  await ws.open();
  let peak = 0;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !ws.closed) {
    peak = Math.max(peak, ws.socket.writableLength ?? 0);
    await wait(10);
  }
  assert.ok(peak < 1024 * 1024, `pending writes peaked at ${peak} bytes`);
});
