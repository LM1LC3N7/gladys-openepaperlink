// -----------------------------------------------------------------------------
// A small websocket client (RFC 6455) over a plain TCP socket, for the
// `ws://<access point>/ws` events. Written here rather than taken from Node's
// global WebSocket so every bound is ours:
//
//   - the headers of the handshake answer are read into one fixed buffer of
//     LIMITS.wsHandshakeBytes, within TIMINGS.handshakeTimeout; status,
//     Upgrade, Connection and Sec-WebSocket-Accept are checked, an extension
//     or a subprotocol is refused; the bytes after them reach the parser at
//     the next turn, once the caller attached the client;
//   - a frame is parsed by a state machine: its header in a 14-byte buffer,
//     its payload copied once into a buffer of its announced size (refused
//     beyond LIMITS.wsMessageBytes before any byte of it is kept): no
//     concatenation per chunk, the cost is linear in the bytes received;
//   - a fragmented message keeps at most LIMITS.wsFragments pieces and
//     LIMITS.wsMessageBytes in all, joined once at its last frame;
//   - frames from the server must not be masked; ours always are;
//   - a ping every TIMINGS.pingInterval, and no byte for TIMINGS.idleTimeout
//     closes the connection; a frame or message unfinished after
//     TIMINGS.frameTimeout too;
//   - at most LIMITS.wsPingsInARow pings in a row, one pong waiting at most,
//     and a peer that leaves LIMITS.wsPendingWrite unread is closed;
//   - text is strict UTF-8; a close frame of one byte is a protocol error.
//
// The socket comes from a factory (`net.connect` by default) so the tests can
// use a real local server.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import { ApError, KINDS } from './errors.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = Object.freeze({ CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 });
/** Strict UTF-8: a text message with invalid bytes is a protocol error. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The value of Sec-WebSocket-Accept for a key. */
export const acceptFor = (key) =>
  createHash('sha1')
    .update(key + GUID)
    .digest('base64');

/** One frame from the client: always masked. */
export function encodeFrame(opcode, payload = Buffer.alloc(0), mask = randomBytes(4)) {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  mask.copy(frame, headerLength);
  for (let i = 0; i < length; i += 1) {
    frame[headerLength + 4 + i] = payload[i] ^ mask[i & 3];
  }
  return frame;
}

/**
 * The frame parser: `push(chunk)` for every chunk received, in order; it
 * calls `onFrame({ fin, opcode, payload })` for every complete frame and
 * throws an ApError PROTOCOL on a broken or oversized frame.
 */
export class FrameParser {
  constructor({ maxPayload = LIMITS.wsMessageBytes, onFrame }) {
    this.maxPayload = maxPayload;
    this.onFrame = onFrame;
    this.header = Buffer.alloc(14);
    this.headerFill = 0;
    this.headerNeed = 2;
    this.payload = undefined;
    this.payloadFill = 0;
    this.fin = false;
    this.opcode = 0;
  }

  /** True while a frame is started but not complete. */
  get busy() {
    return this.headerFill > 0 || this.payload !== undefined;
  }

  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === undefined) {
        const take = Math.min(this.headerNeed - this.headerFill, chunk.length - offset);
        chunk.copy(this.header, this.headerFill, offset, offset + take);
        this.headerFill += take;
        offset += take;
        if (this.headerFill === this.headerNeed) {
          this.headerDone();
        }
      } else {
        const take = Math.min(this.payload.length - this.payloadFill, chunk.length - offset);
        chunk.copy(this.payload, this.payloadFill, offset, offset + take);
        this.payloadFill += take;
        offset += take;
        if (this.payloadFill === this.payload.length) {
          this.frameDone();
        }
      }
    }
  }

  headerDone() {
    const b0 = this.header[0];
    const b1 = this.header[1];
    if (this.headerNeed === 2) {
      if (b0 & 0x70) {
        throw new ApError(KINDS.PROTOCOL, 'Websocket frame with reserved bits');
      }
      if (b1 & 0x80) {
        throw new ApError(KINDS.PROTOCOL, 'Masked websocket frame from the server');
      }
      const short = b1 & 0x7f;
      if (short === 126 || short === 127) {
        this.headerNeed = short === 126 ? 4 : 10;
        return;
      }
      this.start(short);
      return;
    }
    let length;
    if (this.headerNeed === 4) {
      length = this.header.readUInt16BE(2);
    } else {
      const big = this.header.readBigUInt64BE(2);
      length = big > BigInt(this.maxPayload) ? Infinity : Number(big);
    }
    this.start(length);
  }

  start(length) {
    const opcode = this.header[0] & 0x0f;
    const fin = Boolean(this.header[0] & 0x80);
    const control = opcode >= 8;
    if (control && (length > 125 || !fin)) {
      throw new ApError(KINDS.PROTOCOL, 'Websocket control frame too long or fragmented');
    }
    if (length > this.maxPayload) {
      throw new ApError(KINDS.PROTOCOL, `Websocket frame larger than ${this.maxPayload} bytes`);
    }
    this.fin = fin;
    this.opcode = opcode;
    this.payload = Buffer.allocUnsafe(length);
    this.payloadFill = 0;
    if (length === 0) {
      this.frameDone();
    }
  }

  frameDone() {
    const frame = { fin: this.fin, opcode: this.opcode, payload: this.payload };
    this.payload = undefined;
    this.payloadFill = 0;
    this.headerFill = 0;
    this.headerNeed = 2;
    this.onFrame(frame);
  }
}

/**
 * One websocket connection. `open()` resolves once the handshake succeeded;
 * then `onMessage(text)` is called for every text message and `onClose(reason)`
 * once when the connection ends (any side, any cause).
 */
export class WsClient {
  constructor({
    host,
    port = 80,
    path = '/ws',
    connect = netConnect,
    timers = globalThis,
    timings = TIMINGS,
    maxMessage = LIMITS.wsMessageBytes,
    onMessage = () => {},
    onClose = () => {},
  }) {
    this.host = host;
    this.port = port;
    this.path = path;
    this.connectImpl = connect;
    this.timers = timers;
    this.timings = timings;
    this.maxMessage = maxMessage;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.socket = undefined;
    this.closed = false;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.parser = undefined;
    /** Bytes received in the handshake turn, parsed at the next turn. */
    this.held = undefined;
    this.frameTimer = undefined;
    this.pingsInARow = 0;
    this.pongPending = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      let handshake = true;
      // The handshake answer goes into one buffer sized once: only its
      // headers are bounded, what follows them goes to the frame parser.
      const head = Buffer.allocUnsafe(LIMITS.wsHandshakeBytes);
      let headLength = 0;
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.end(err?.message ?? 'error');
      };
      const socket = this.connectImpl({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay?.(true);
      const handshakeTimer = this.timers.setTimeout(
        () => fail(new ApError(KINDS.NO_ANSWER, 'No websocket handshake in time')),
        this.timings.handshakeTimeout,
      );
      this.parser = new FrameParser({
        maxPayload: this.maxMessage,
        onFrame: (frame) => this.frame(frame),
      });
      socket.on('connect', () => {
        socket.write(
          [
            `GET ${this.path} HTTP/1.1`,
            `Host: ${this.port === 80 ? this.host : `${this.host}:${this.port}`}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      socket.on('data', (chunk) => {
        if (this.closed) {
          return;
        }
        this.armIdle();
        try {
          if (!handshake) {
            this.receive(chunk);
            return;
          }
          const before = headLength;
          const take = Math.min(chunk.length, head.length - headLength);
          chunk.copy(head, headLength, 0, take);
          headLength += take;
          const end = head.subarray(0, headLength).indexOf('\r\n\r\n', Math.max(0, before - 3));
          if (end < 0) {
            if (headLength >= head.length) {
              throw new ApError(KINDS.PROTOCOL, 'Websocket handshake answer too long');
            }
            return;
          }
          this.checkHandshake(head.subarray(0, end).toString('latin1'), key);
          handshake = false;
          this.timers.clearTimeout(handshakeTimer);
          settled = true;
          this.startPing();
          // What came after the headers is held until the next turn, so the
          // caller has attached this client before any message or close.
          this.held = [chunk.subarray(end + 4 - before)];
          resolve();
          setImmediate(() => this.release());
        } catch (err) {
          this.timers.clearTimeout(handshakeTimer);
          fail(err);
        }
      });
      socket.on('error', (err) => {
        this.timers.clearTimeout(handshakeTimer);
        const code = err?.code;
        const unreachable = [
          'ECONNREFUSED',
          'EHOSTUNREACH',
          'ENETUNREACH',
          'EHOSTDOWN',
          'ENOTFOUND',
          'EAI_AGAIN',
        ].includes(code);
        fail(
          new ApError(
            unreachable ? KINDS.UNREACHABLE : KINDS.NO_ANSWER,
            `Websocket ${unreachable ? 'unreachable' : 'error'} (${code ?? 'unknown'})`,
          ),
        );
      });
      socket.on('close', () => {
        this.timers.clearTimeout(handshakeTimer);
        fail(new ApError(KINDS.NO_ANSWER, 'Websocket closed'));
      });
    });
  }

  /** The 101 answer: status, Upgrade, Connection, accept key; no extension nor subprotocol. */
  checkHandshake(text, key) {
    const [status, ...lines] = text.split('\r\n');
    if (!/^HTTP\/1\.1 101\b/.test(status ?? '')) {
      throw new ApError(KINDS.HTTP, `Websocket refused (${(status ?? '').slice(0, 40)})`);
    }
    const headers = new Map();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
    }
    if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      throw new ApError(KINDS.PROTOCOL, 'Websocket handshake without Upgrade: websocket');
    }
    const connection = (headers.get('connection') ?? '').toLowerCase().split(/\s*,\s*/);
    if (!connection.includes('upgrade')) {
      throw new ApError(KINDS.PROTOCOL, 'Websocket handshake without Connection: Upgrade');
    }
    if (headers.has('sec-websocket-extensions') || headers.has('sec-websocket-protocol')) {
      throw new ApError(KINDS.PROTOCOL, 'Websocket extension or subprotocol not asked for');
    }
    if (headers.get('sec-websocket-accept') !== acceptFor(key)) {
      throw new ApError(KINDS.PROTOCOL, 'Websocket handshake not acknowledged');
    }
  }

  /** Bytes after the handshake: held until released, then parsed in order. */
  receive(chunk) {
    if (this.held) {
      this.held.push(chunk);
      return;
    }
    this.parser.push(chunk);
    this.watchFrame();
  }

  /** The bytes held during the handshake turn, parsed once the caller attached. */
  release() {
    const held = this.held ?? [];
    this.held = undefined;
    if (this.closed) {
      return;
    }
    try {
      for (const chunk of held) {
        if (chunk.length) {
          this.parser.push(chunk);
        }
        if (this.closed) {
          return;
        }
      }
      this.watchFrame();
    } catch (err) {
      this.end(err?.message ?? 'error');
    }
  }

  /**
   * A frame or a message left unfinished has TIMINGS.frameTimeout from its
   * first byte to complete (a byte now and then never keeps it open).
   */
  watchFrame() {
    const busy = this.parser.busy || this.fragments.length > 0;
    if (!busy) {
      this.timers.clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    } else if (!this.frameTimer && !this.closed) {
      this.frameTimer = this.timers.setTimeout(
        () => this.end('websocket frame not completed in time'),
        this.timings.frameTimeout,
      );
    }
  }

  frame({ fin, opcode, payload }) {
    if (this.closed) {
      return;
    }
    if (opcode === OP.PING) {
      // A ping flood, or a peer that does not read what we write: closed.
      this.pingsInARow += 1;
      if (this.pingsInARow > LIMITS.wsPingsInARow) {
        throw new ApError(KINDS.PROTOCOL, 'Too many websocket pings');
      }
      if ((this.socket?.writableLength ?? 0) > LIMITS.wsPendingWrite) {
        throw new ApError(KINDS.PROTOCOL, 'The access point does not read the websocket');
      }
      // One pong waiting at most: a later ping is answered once it is written.
      if (!this.pongPending && !this.closed && this.socket && !this.socket.destroyed) {
        this.pongPending = true;
        this.socket.write(encodeFrame(OP.PONG, payload), () => {
          this.pongPending = false;
        });
      }
      return;
    }
    this.pingsInARow = 0;
    switch (opcode) {
      case OP.PONG:
        return;
      case OP.CLOSE:
        if (payload.length === 1) {
          throw new ApError(KINDS.PROTOCOL, 'Websocket close frame of one byte');
        }
        this.send(OP.CLOSE, payload.subarray(0, 2));
        this.end('closed by the access point');
        return;
      case OP.TEXT:
      case OP.BINARY:
        if (this.fragments.length) {
          throw new ApError(KINDS.PROTOCOL, 'Websocket message started inside another');
        }
        this.fragmentOpcode = opcode;
        break;
      case OP.CONT:
        if (!this.fragments.length) {
          throw new ApError(KINDS.PROTOCOL, 'Websocket continuation without a message');
        }
        break;
      default:
        throw new ApError(KINDS.PROTOCOL, `Unknown websocket opcode ${opcode}`);
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessage || this.fragments.length >= LIMITS.wsFragments) {
      throw new ApError(KINDS.PROTOCOL, `Websocket message larger than ${this.maxMessage} bytes`);
    }
    this.fragments.push(payload);
    if (!fin) {
      return;
    }
    const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    const text = this.fragmentOpcode === OP.TEXT;
    this.fragments = [];
    this.fragmentBytes = 0;
    if (text) {
      let decoded;
      try {
        decoded = UTF8.decode(message);
      } catch {
        throw new ApError(KINDS.PROTOCOL, 'Websocket text that is not UTF-8');
      }
      try {
        this.onMessage(decoded);
      } catch {
        // A handler error is the app's own: it never breaks the connection.
      }
    }
  }

  /** Writes a frame; a peer that does not read (64 KB waiting) is closed instead. */
  send(opcode, payload) {
    if (this.closed || !this.socket || this.socket.destroyed) {
      return;
    }
    if ((this.socket.writableLength ?? 0) > LIMITS.wsPendingWrite) {
      this.end('the access point does not read the websocket');
      return;
    }
    this.socket.write(encodeFrame(opcode, payload));
  }

  startPing() {
    this.armIdle();
    const beat = () => {
      if (this.closed) {
        return;
      }
      this.send(OP.PING, Buffer.alloc(0));
      this.pingTimer = this.timers.setTimeout(beat, this.timings.pingInterval);
    };
    this.pingTimer = this.timers.setTimeout(beat, this.timings.pingInterval);
  }

  armIdle() {
    if (this.closed) {
      return;
    }
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(
      () => this.end('no data from the access point'),
      this.timings.idleTimeout,
    );
  }

  /** Ends the connection (idempotent); `onClose` once. */
  end(reason = 'closed') {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.timers.clearTimeout(this.pingTimer);
    this.timers.clearTimeout(this.idleTimer);
    this.timers.clearTimeout(this.frameTimer);
    this.held = undefined;
    this.socket?.destroy();
    this.onClose(reason);
  }

  close() {
    if (!this.closed) {
      this.send(OP.CLOSE, Buffer.from([0x03, 0xe8]));
    }
    this.end('closed');
  }
}
