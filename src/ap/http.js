// -----------------------------------------------------------------------------
// The only HTTP access: `fetch` with an explicit timer (not
// AbortSignal.timeout, whose timer does not keep the process alive), a capped
// answer size read chunk by chunk into one buffer, no redirect followed, and
// the network failures sorted into "nothing reached the access point" and "no
// answer in time".
// -----------------------------------------------------------------------------

import { ApError, KINDS } from './errors.js';

/** Codes of a request that never reached the access point. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const text = String(value).trim();
  if (/^\d{1,9}$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * Reads at most `maxBytes` of a body into one buffer sized once (no
 * concatenation per chunk); a longer answer is an error.
 */
async function readCapped(response, maxBytes) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const out = Buffer.allocUnsafe(maxBytes);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (size + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApError(KINDS.BAD_RESPONSE, `Answer larger than ${maxBytes} bytes`);
    }
    out.set(value, size);
    size += value.byteLength;
  }
  return out.toString('utf8', 0, size);
}

/** The code of a fetch failure (undici puts it on `cause`, sometimes one level deeper). */
const failureCode = (err) => err?.cause?.code ?? err?.cause?.cause?.code ?? err?.code;

/**
 * One HTTP exchange. Resolves `{ status, headers, body }` for any status;
 * rejects with an ApError UNREACHABLE (nothing reached the access point) or
 * NO_ANSWER (timeout, connection dropped: it may have reached it).
 */
export async function httpRequest(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 5_000, maxBytes = 64 * 1024 } = {},
  fetchImpl = globalThis.fetch,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(1, timeoutMs),
  );
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await readCapped(response, maxBytes);
    return { status: response.status, headers: response.headers, body: text };
  } catch (err) {
    if (err instanceof ApError) {
      throw err;
    }
    if (timedOut) {
      throw new ApError(KINDS.NO_ANSWER, `No answer within ${timeoutMs} ms`);
    }
    const code = failureCode(err);
    if (UNREACHABLE_CODES.has(code)) {
      throw new ApError(KINDS.UNREACHABLE, `Access point unreachable (${code})`);
    }
    throw new ApError(KINDS.NO_ANSWER, `Network error (${code ?? err?.name ?? 'unknown'})`);
  } finally {
    clearTimeout(timer);
  }
}
