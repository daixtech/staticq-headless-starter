// ===========================================================================
//  Safely joining another request's in-flight promise
// ===========================================================================
//
// Several fetchers here keep a module-scope "in-flight" slot so that two
// renders needing the same URL at the same moment cost one origin call
// instead of two. Module scope means that slot is shared by every request
// the isolate handles - which is the point, and also a trap.
//
// THE TRAP: a promise belongs to the request that created it. When that
// request finishes or is cancelled, the Workers runtime cancels its pending
// I/O. Any OTHER request still awaiting that promise is now waiting on
// something that can never settle. It has no I/O of its own outstanding, so
// its event loop goes empty with no response produced, and the runtime kills
// it:
//
//   "The Workers runtime canceled this request because it detected that your
//    Worker's code had hung and would never generate a response."
//
// Observed on a 10k-URL warmup: 351 such 500s. cpuTime peaked at 38ms while
// wallTime reached 24.9s - the isolate was not busy, it was stuck. Whole
// batches died together (28 of the 41 affected batches failed 10-for-10),
// because a warmup fires many URLs into one isolate and they all join the
// same shared lookups.
//
// THE FIX: never await a shared promise unconditionally. Race it against a
// timer owned by the CURRENT request. Two things follow:
//
//   1. A pending timer is pending work, so the runtime no longer sees an idle
//      Worker and stops killing the request outright.
//   2. If the shared promise really is dead, we fall back to doing the fetch
//      ourselves. One duplicate origin call, instead of a 500.
//
// The happy path is unchanged: the race settles the moment the shared promise
// settles, so joiners still pay zero extra calls and wait no longer than the
// owner does. Rejections propagate as before - a shared failure is still a
// shared failure.

/**
 * How long to wait on another request's promise before assuming it died.
 *
 * Generous on purpose. This is not a performance timeout - the shared
 * promise resolving is the normal case and ends the wait immediately. It
 * only needs to be longer than a legitimately slow origin call, or we would
 * duplicate fetches during exactly the load spikes we are trying not to make
 * worse.
 */
const SHARED_WAIT_MS = 8000;

/** Distinguishes "the timer won" from a legitimate resolved value. */
const TIMED_OUT = Symbol('shared-inflight-timeout');

/**
 * Await `shared` (another request's in-flight promise), falling back to
 * `fetchFresh()` if it hasn't settled within the grace period.
 *
 * @param shared     The promise found in a module-scope in-flight slot.
 * @param fetchFresh Issues the same request owned by the caller. Only run
 *                   when the shared promise appears abandoned.
 */
export async function joinInflight<T>(
	shared: Promise<T>,
	fetchFresh: () => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), SHARED_WAIT_MS);
	});

	try {
		const winner = await Promise.race([shared, expiry]);
		if (winner !== TIMED_OUT) return winner as T;
		// The owner is gone. Do it ourselves rather than wait forever.
		return await fetchFresh();
	} finally {
		// Leaving the timer pending would keep the invocation alive after the
		// response is done.
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Upper bound on a single WP fetch, so a stalled origin surfaces as a
 * rejected promise the caller can degrade on, rather than an open socket the
 * whole render waits behind.
 */
export const WP_FETCH_TIMEOUT_MS = 15000;
