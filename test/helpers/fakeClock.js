// -----------------------------------------------------------------------------
// A clock the tests move by hand: `now()`, the timers the app schedules
// (`setTimeout`/`clearTimeout`), and `advance(ms)` that runs every timer due
// in order, letting the promises they start settle in between.
// -----------------------------------------------------------------------------

export function fakeClock(start = Date.UTC(2026, 9, 18, 12, 0, 0)) {
  let current = start;
  let seq = 0;
  const pending = new Map();

  const timers = {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { at: current + Math.max(0, Number(ms) || 0), fn });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };

  /** Lets the promise chains and setImmediate callbacks of the fakes run. */
  async function settle(rounds = 30) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function advance(ms) {
    const end = current + ms;
    for (;;) {
      await settle();
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= end && (!next || timer.at < next[1].at)) {
          next = [id, timer];
        }
      }
      if (!next) {
        break;
      }
      pending.delete(next[0]);
      current = Math.max(current, next[1].at);
      next[1].fn();
    }
    current = end;
    await settle();
  }

  /** When the timers are due, relative to now (for the tests that check spacing). */
  const due = () => [...pending.values()].map((t) => t.at - current).sort((a, b) => a - b);

  return { now: () => current, timers, advance, settle, due };
}
