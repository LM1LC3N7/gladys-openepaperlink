// -----------------------------------------------------------------------------
// The HTTP API of the OpenEPaperLink access point, as the Home Assistant
// integration of the project calls it (OpenEPaperLink/Home_Assistant_Integration,
// Apache-2.0): `GET /get_db` (paged by `pos`, one tag with `mac`),
// `GET /tagtypes/<hw type>.json`, and `POST /imgupload` (multipart: the
// `mac` and the options first, then the JPEG). Statuses are sorted here into
// the kinds the app decides on. The access point has no authentication.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { LIMITS, PATHS, TIMINGS } from '../constants.js';
import { ApError, KINDS } from './errors.js';
import { httpRequest, retryAfterMs } from './http.js';
import { isMac, parseDbPage, parseJson, parseTagType } from './parse.js';

export class ApApi {
  constructor({
    baseUrl,
    request = httpRequest,
    fetchImpl,
    now = Date.now,
    timings = TIMINGS,
    pausedUntil = () => 0,
  }) {
    this.baseUrl = baseUrl;
    this.request = request;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timings = timings;
    this.pausedUntil = pausedUntil;
  }

  /** One call; resolves the body text of a 2xx answer. */
  async call(path, { method = 'GET', headers = {}, body, timeoutMs, maxBytes } = {}) {
    if (this.pausedUntil() > this.now()) {
      throw new ApError(KINDS.PAUSED, 'Paused after a 429, 5xx or busy answer');
    }
    const response = await this.request(
      `${this.baseUrl}${path}`,
      {
        method,
        headers,
        body,
        timeoutMs: timeoutMs ?? this.timings.httpTimeout,
        maxBytes: maxBytes ?? LIMITS.responseBytes,
      },
      this.fetchImpl,
    );
    const { status } = response;
    if (status >= 200 && status < 300) {
      return response.body;
    }
    const retry = retryAfterMs(response.headers?.get?.('retry-after'), this.now());
    const text = String(response.body ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 60)
      .trim();
    const detail = text ? `: ${text}` : '';
    if (status === 429) {
      throw new ApError(KINDS.RATE_LIMITED, `The access point asked to slow down (429)`, {
        status,
        retryAfterMs: retry,
      });
    }
    if (status === 409) {
      throw new ApError(KINDS.BUSY, `The access point is busy (409${detail})`, {
        status,
        retryAfterMs: retry,
      });
    }
    if (status >= 500) {
      throw new ApError(KINDS.UNAVAILABLE, `The access point answered ${status}`, {
        status,
        retryAfterMs: retry,
      });
    }
    throw new ApError(KINDS.HTTP, `The access point answered ${status}${detail}`, { status });
  }

  /** The JSON of a GET, which must be there. */
  async json(path) {
    const json = parseJson(await this.call(path));
    if (json === undefined) {
      throw new ApError(KINDS.BAD_RESPONSE, `No JSON answer for ${path.split('?')[0]}`);
    }
    return json;
  }

  /**
   * Every tag of the access point, page after page (at most LIMITS.dbPages
   * pages and LIMITS.tags tags); `alive()` is called after every page so a
   * reading of an old client stops there.
   */
  async tags(alive = () => {}) {
    const tags = [];
    let pos = 0;
    for (let page = 0; page < LIMITS.dbPages; page += 1) {
      const json = await this.json(pos ? `${PATHS.DB}?pos=${pos}` : PATHS.DB);
      alive();
      const parsed = parseDbPage(json);
      if (!parsed) {
        throw new ApError(KINDS.BAD_RESPONSE, 'The tag list is not a list');
      }
      tags.push(...parsed.tags);
      if (!parsed.next || parsed.next <= pos || tags.length >= LIMITS.tags) {
        return tags.slice(0, LIMITS.tags);
      }
      pos = parsed.next;
    }
    return tags.slice(0, LIMITS.tags);
  }

  /** One tag as the access point knows it now, or undefined when it does not. */
  async tag(mac) {
    if (!isMac(mac)) {
      return undefined;
    }
    const parsed = parseDbPage(await this.json(`${PATHS.DB}?mac=${mac}`));
    if (!parsed) {
      throw new ApError(KINDS.BAD_RESPONSE, 'The tag answer is not a list');
    }
    return parsed.tags.find((t) => t.mac === mac);
  }

  /** The display of a hardware type: { width, height, colors }. */
  async tagType(hwType) {
    const type = parseTagType(await this.json(PATHS.tagType(hwType)));
    if (!type) {
      throw new ApError(KINDS.BAD_RESPONSE, `No display size for the hardware type ${hwType}`);
    }
    return type;
  }

  /**
   * Sends a JPEG for a tag: the access point stores it and the tag shows it
   * at its next check-in. `dither` 0: the image already uses the colours of
   * the display.
   */
  async upload(mac, jpeg, { timeoutMs, dither = 0 } = {}) {
    const boundary = `----gladys-oepl-${randomBytes(12).toString('hex')}`;
    const field = (name, value) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    // The access point reads `mac` when the file starts: the fields go first.
    const body = Buffer.concat([
      field('mac', mac),
      field('dither', String(dither)),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="gladys.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await this.call(PATHS.IMAGE_UPLOAD, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      timeoutMs: timeoutMs ?? this.timings.uploadTimeout,
      maxBytes: 4 * 1024,
    });
  }
}
