// -----------------------------------------------------------------------------
// A fake OpenEPaperLink access point: its HTTP API behind `fetch` and its
// websocket behind a socket factory (an in-memory socket speaking the
// handshake and unmasked server frames). The tests change its state (down,
// 5xx, busy…), push websocket messages, and read the requests and uploads it
// received.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { acceptFor } from '../../src/ap/websocket.js';

export const HOST = '192.168.1.30';
export const KITCHEN = 'A1B2C3D4E5F60001';
export const DESK = 'A1B2C3D4E5F60002';
export const NOW_S = Math.floor(Date.UTC(2026, 9, 18, 12, 0, 0) / 1000);

const failure = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

/** A server frame (never masked). */
export function serverFrame(text, opcode = 1) {
  const payload = Buffer.from(text);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x80 | opcode;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(length), 2);
            return h;
          })();
  return Buffer.concat([header, payload]);
}

export function tagRecord(mac, extra = {}) {
  return {
    mac,
    hash: '00000000000000000000000000000000',
    lastseen: NOW_S - 30,
    nextupdate: 0,
    nextcheckin: NOW_S + 30,
    pending: 0,
    alias: mac === KITCHEN ? 'Cuisine' : '',
    contentMode: 0,
    LQI: 100,
    RSSI: -60,
    temperature: 21,
    batteryMv: 2900,
    hwType: mac === KITCHEN ? 1 : 0,
    wakeupReason: 0,
    capabilities: 0,
    modecfgjson: '',
    isexternal: false,
    ...extra,
  };
}

export function fakeAp() {
  const ap = {
    /** 'up', 'down' (nothing reaches it), 'hang' (no answer at all). */
    mode: 'up',
    /** 'up', 'refuse' (no upgrade), 'down'. */
    wsMode: 'up',
    tags: [tagRecord(KITCHEN), tagRecord(DESK)],
    tagTypes: {
      '01': {
        version: 1,
        name: 'M2 2.9"',
        width: 296,
        height: 128,
        colortable: { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0] },
      },
      '00': {
        version: 1,
        name: 'M2 1.54"',
        width: 152,
        height: 152,
        colortable: { white: [255, 255, 255], black: [0, 0, 0] },
      },
    },
    /** path -> forced status. */
    statuses: new Map(),
    retryAfter: new Map(),
    /** paths that never answer (until the request is aborted). */
    hang: new Set(),
    pageSize: 50,
    requests: [],
    uploads: [],
    sockets: [],
  };

  const json = (status, body, headers = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  ap.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const path = target.pathname;
    ap.requests.push({ method: init.method ?? 'GET', path, query: target.search, init });
    if (ap.mode === 'down') {
      throw failure('ECONNREFUSED');
    }
    if (ap.mode === 'hang' || ap.hang.has(path)) {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }
    const forced = ap.statuses.get(path);
    if (forced) {
      const extra = ap.retryAfter.has(path) ? { 'retry-after': ap.retryAfter.get(path) } : {};
      return json(forced, 'forced', extra);
    }
    if (path === '/get_db') {
      const mac = target.searchParams.get('mac');
      if (mac) {
        return json(200, { tags: ap.tags.filter((t) => t.mac === mac) });
      }
      const pos = Number(target.searchParams.get('pos') ?? 0);
      const page = ap.tags.slice(pos, pos + ap.pageSize);
      const body = { tags: page };
      if (pos + ap.pageSize < ap.tags.length) {
        body.continu = pos + ap.pageSize;
      }
      return json(200, body);
    }
    const type = path.match(/^\/tagtypes\/([0-9A-F]{2,4})\.json$/);
    if (type) {
      return ap.tagTypes[type[1]] ? json(200, ap.tagTypes[type[1]]) : json(404, 'File not found');
    }
    if (path === '/imgupload' && init.method === 'POST') {
      const body = Buffer.from(init.body);
      const text = body.toString('latin1');
      const macAt = text.indexOf('name="mac"');
      const fileAt = text.indexOf('name="file"');
      const mac = text.slice(macAt).split('\r\n')[2];
      const start = text.indexOf('\r\n\r\n', fileAt) + 4;
      const end = text.lastIndexOf('\r\n--');
      ap.uploads.push({
        mac,
        macFirst: macAt >= 0 && macAt < fileAt,
        dither: text.slice(text.indexOf('name="dither"')).split('\r\n')[2],
        jpeg: body.subarray(start, end),
        contentType: init.headers?.['Content-Type'],
      });
      if (!ap.tags.some((t) => t.mac === mac)) {
        return new Response('mac not found', { status: 400 });
      }
      return new Response('', { status: 200 });
    }
    return json(404, 'Not found');
  };

  /** The socket factory given to the app (`connectSocket`). */
  ap.connect = ({ host, port }) => {
    const socket = new EventEmitter();
    socket.host = host;
    socket.port = port;
    socket.destroyed = false;
    socket.written = [];
    socket.setNoDelay = () => {};
    socket.destroy = () => {
      if (!socket.destroyed) {
        socket.destroyed = true;
        setImmediate(() => socket.emit('close'));
      }
    };
    socket.write = (data) => {
      if (socket.destroyed) {
        return;
      }
      socket.written.push(Buffer.from(data));
      const text = Buffer.from(data).toString('latin1');
      const key = text.match(/Sec-WebSocket-Key: (\S+)/)?.[1];
      if (key) {
        setImmediate(() => {
          if (ap.wsMode === 'refuse') {
            socket.emit('data', Buffer.from('HTTP/1.1 404 Not Found\r\n\r\n'));
            return;
          }
          socket.emit(
            'data',
            Buffer.from(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
            ),
          );
        });
      }
    };
    ap.sockets.push(socket);
    setImmediate(() => {
      if (ap.wsMode === 'down' || ap.mode === 'down') {
        socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
        socket.destroy();
      } else {
        socket.emit('connect');
      }
    });
    return socket;
  };

  /** The open socket (the last one not destroyed). */
  ap.socket = () => ap.sockets.findLast((s) => !s.destroyed);
  /** Pushes a websocket message (object as JSON, or raw bytes) on the open socket. */
  ap.push = (message) => {
    const socket = ap.socket();
    const bytes = Buffer.isBuffer(message)
      ? message
      : serverFrame(typeof message === 'string' ? message : JSON.stringify(message));
    socket.emit('data', bytes);
  };
  ap.count = (path) => ap.requests.filter((r) => r.path === path).length;
  return ap;
}
