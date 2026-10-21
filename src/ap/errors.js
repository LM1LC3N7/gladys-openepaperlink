// -----------------------------------------------------------------------------
// One error type for everything the access point can answer, with a kind the
// app decides on.
// -----------------------------------------------------------------------------

export const KINDS = Object.freeze({
  /** Nothing reached the access point (connection refused, host unreachable, unknown name). */
  UNREACHABLE: 'unreachable',
  /** The request may have reached the access point but no answer came in time. */
  NO_ANSWER: 'no_answer',
  /** A reading of a previous client (new address, "Reconnect"): dropped. */
  STALE: 'stale',
  /** 5xx. */
  UNAVAILABLE: 'unavailable',
  /** 429, with `retryAfterMs` when the answer said it. */
  RATE_LIMITED: 'rate_limited',
  /** 409: the access point is busy (or its radio is not running). */
  BUSY: 'busy',
  /** Any other HTTP status. */
  HTTP: 'http',
  BAD_RESPONSE: 'bad_response',
  /** The request was not sent: paused after a 429, 5xx or 409. */
  PAUSED: 'paused',
  /** The text had no time left: nothing was sent. */
  BUDGET: 'budget',
  /** A text replaced by a newer one for the same tag before it was sent. */
  REPLACED: 'replaced',
  /** The websocket broke its protocol or its bounds. */
  PROTOCOL: 'protocol',
});

export class ApError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}
