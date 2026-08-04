// Worker-identity flag, isolated into a single module so that swapping one
// small file is all it takes to turn a deploy into a non-caching one.
//
// AS SHIPPED: always false. The Worker uses the edge + R2 cache layers and
// indexes according to SITE_INDEXABLE. The `if (IS_STAGING)` branches
// elsewhere (middleware, robots, Base) read this flag and stay inert.
//
// TO RUN A SECOND, NON-CACHING WORKER — a preview deploy that should render
// fresh on every request and never be indexed — replace the export below
// with the real check, and deploy that Worker with WORKER_ENV=staging:
//
//   import { envStr } from './runtime-env';
//   export const IS_STAGING = envStr('WORKER_ENV', 'production').toLowerCase() === 'staging';
//
// Keeping the flag in its own module means that is the ONLY edit — nothing
// that consumes IS_STAGING has to change.
//
// Annotated `: boolean` (not the literal `false`) so TypeScript doesn't
// narrow the flag and report the `if (IS_STAGING)` branches as unreachable.
export const IS_STAGING: boolean = false;
