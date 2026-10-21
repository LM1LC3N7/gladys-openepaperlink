// -----------------------------------------------------------------------------
// A small websocket client (RFC 6455) over a plain TCP socket, for the
// `ws://<access point>/ws` events. Written here rather than taken from Node's
// global WebSocket so every bound is ours:
//
//   - the handshake answer is read up to LIMITS.wsHandshakeBytes, within
//     TIMINGS.handshakeTimeout, and its Sec-WebSocket-Accept is checked;
//   - a frame is parsed by a state machine: its header in a 14-byte buffer,
//     its payload copied once into a buffer of its announced size (refused
//     beyond LIMITS.wsMessageBytes before any byte of it is kept): no
//     concatenation per chunk, the cost is linear in the bytes received;
//   - a fragmented message keeps at most LIMITS.wsFragments pieces and
//     LIMITS.wsMessageBytes in all, joined once at its last frame;
//   - frames from the server must not be masked; ours always are;
//   - a ping every TIMINGS.pingInterval, and no byte for TIMINGS.idleTimeout
//     closes the connection.
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
  }

  open() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      let handshake = true;
      let head = Buffer.alloc(0);
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
      const parser = new FrameParser({
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
        this.armIdle();
        try {
          if (!handshake) {
            parser.push(chunk);
            return;
          }
          // The handshake answer: small, bounded, read until its blank line.
          if (head.length + chunk.length > LIMITS.wsHandshakeBytes) {
            throw new ApError(KINDS.PROTOCOL, 'Websocket handshake answer too long');
          }
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf('\r\n\r\n');
          if (end < 0) {
            return;
          }
          const lines = head.subarray(0, end).toString('latin1').split('\r\n');
          if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? '')) {
            throw new ApError(KINDS.HTTP, `Websocket refused (${(lines[0] ?? '').slice(0, 40)})`);
          }
          const accept = lines
            .slice(1)
            .map((l) => l.match(/^sec-websocket-accept:\s*(\S+)\s*$/i))
            .find(Boolean)?.[1];
          if (accept !== acceptFor(key)) {
            throw new ApError(KINDS.PROTOCOL, 'Websocket handshake not acknowledged');
          }
          handshake = false;
          this.timers.clearTimeout(handshakeTimer);
          settled = true;
          this.startPing();
          resolve();
          const rest = head.subarray(end + 4);
          head = undefined;
          if (rest.length) {
            parser.push(rest);
          }
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

  frame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING:
        this.send(OP.PONG, payload);
        return;
      case OP.PONG:
        return;
      case OP.CLOSE:
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
      try {
        this.onMessage(message.toString('utf8'));
      } catch {
        // A handler error is the app's own: it never breaks the connection.
      }
    }
  }

  send(opcode, payload) {
    if (!this.closed && this.socket && !this.socket.destroyed) {
      this.socket.write(encodeFrame(opcode, payload));
    }
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
