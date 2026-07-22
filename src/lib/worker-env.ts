// Worker-identity flag, isolated into a single module so it is the ONE
// file that differs between the free starter and the Pro staging overlay.
//
// FREE (this file): never staging — the production Worker always uses the
// edge + R2 cache layers and indexes per SITE_INDEXABLE. The staging
// branches elsewhere (middleware, robots, Base) read this flag and stay
// inert.
//
// The Pro staging add-on overlays this one file with the real check:
//   import { envStr } from './runtime-env';
//   export const IS_STAGING = envStr('WORKER_ENV', 'production').toLowerCase() === 'staging';
//
// Annotated `: boolean` (not the literal `false`) so TypeScript doesn't
// narrow the flag and flag the `if (IS_STAGING)` branches as unreachable.
export const IS_STAGING: boolean = false;
