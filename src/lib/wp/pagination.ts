import type { ArchiveLayout } from './types';

// Slot-stable pagination layout. The live page (root URL) holds the newest
// LIVE_MIN..LIVE_MAX posts. Sealed pages each hold exactly SEAL_SIZE posts in
// chronological order, anchored to fixed slots that never change once written.
//
// Math (T = total posts in the term):
//   sealedPagesCount S = max(0, floor((T - LIVE_MIN) / SEAL_SIZE))
//   livePageSize    L = T - S * SEAL_SIZE  (always in [LIVE_MIN..LIVE_MAX] when T >= LIVE_MIN)
//
// Sealed page N (1-indexed, oldest first) holds posts at chronological
// positions [(N-1)*SEAL_SIZE + 1, N*SEAL_SIZE]. Live page holds positions
// [S*SEAL_SIZE + 1, T] displayed newest-first.
export const SEAL_SIZE = 10;
export const LIVE_MIN = 10;
export const LIVE_MAX = 19;

export function computeArchiveLayout(totalPosts: number): ArchiveLayout {
	const T = Math.max(0, totalPosts | 0);
	const sealedPagesCount = T < LIVE_MIN ? 0 : Math.floor((T - LIVE_MIN) / SEAL_SIZE);
	const livePageSize = T - sealedPagesCount * SEAL_SIZE;
	return { totalPosts: T, sealedPagesCount, livePageSize };
}
