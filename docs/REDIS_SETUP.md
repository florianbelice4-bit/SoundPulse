# Redis-backed rate limiting

The backend's rate limiters (`express-rate-limit`) store their counters in Redis
when `REDIS_URL` is set, so limits **persist across deploys and are shared across
instances**. Without `REDIS_URL` (e.g. local dev) they fall back to the built-in
in-memory store automatically — no Redis required to run locally.

- Client + store factory: `railway/backend/src/lib/redis.ts`
- Limiters: `middleware/globalIpRateLimit.ts`, `generateRateLimit.ts`,
  `signupRateLimit.ts`, `userRateLimit.ts`

## Behavior

- **Fail-open.** Every limiter sets `passOnStoreError: true`, and the ioredis
  client is configured to fail fast (`enableOfflineQueue: false`,
  `maxRetriesPerRequest: 1`). If Redis is down or slow, the limiter **allows the
  request** rather than 500-ing users. Connection errors are logged and reported
  to Sentry once per outage (`feature: redis`).
- **Unique keyspaces.** Each limiter uses its own key prefix (`rl:global:`,
  `rl:generate:`, `rl:signup:`, and `rl:<ERROR_CODE>:` for the per-user limits),
  so counters never collide.
- **Limits are unchanged** — only the storage backend moved; windows/maxes are
  identical to before.
- **Health check** (`/v1/health`) is unaffected: it works with Redis down
  (fail-open) and with no Redis at all (memory fallback).

## Railway setup

1. Railway dashboard → your project → **New** → **Database** → **Add Redis**.
2. Railway provisions Redis and injects **`REDIS_URL`** into the backend service
   automatically. (For external Redis, set `REDIS_URL` manually:
   `redis://:<password>@<host>:<port>` or `rediss://…` for TLS.)
3. Redeploy the backend so it picks up `REDIS_URL`.

No other env vars are needed.

## Verification

- **Connected?** Backend logs print `[redis] connected` on startup (and
  `[redis] connection error: …` if it can't reach Redis).
- **Using Redis?** From the Railway Redis shell (or `redis-cli`):
  ```
  KEYS rl:*
  ```
  After a few requests you'll see keys like `rl:global:<ip>` and
  `rl:BILLING_VERIFY_RATE_LIMITED:<user-id>`.
- **Persistence across deploys (the whole point):**
  1. Hit a low-limit endpoint a few times (e.g. `/v1/auth/signup`, 5/hour/IP) to
     get partway to the limit.
  2. Redeploy the backend.
  3. Continue hitting it — the count carries over (you hit `429` at the same
     total), proving state survived the restart. With the old in-memory store the
     counter would have reset to 0.

## Monitoring

- Railway → Redis service → **Metrics** for memory, connections, and ops/sec.
- Rate-limit keys are tiny and auto-expire at each window, so usage stays low.
  Scale the Redis plan only if memory or connection count climbs (e.g. a much
  larger user base or many backend instances).
- Watch Sentry for `feature: redis` events — a burst means Redis was unreachable
  and limiters were failing open during that window.
