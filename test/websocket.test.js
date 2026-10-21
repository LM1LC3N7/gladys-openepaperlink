// -----------------------------------------------------------------------------
// The websocket client against a real local TCP server (127.0.0.1, random
// port) that plays the access point: handshake, messages split in 1-byte
// chunks, fragments, ping, and the bounds that close the connection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { FrameParser, WsClient, acceptFor, encodeFrame } from '../src/ap/websocket.js';
import { serverFrame } from './helpers/fakeAp.js';

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
