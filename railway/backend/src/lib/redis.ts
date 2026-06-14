import * as Sentry from "@sentry/node";
import type { Store } from "express-rate-limit";
import { Redis } from "ioredis";
import { RedisStore, type RedisReply } from "rate-limit-redis";

/**
 * Optional Redis client for rate-limit state that survives deploys and is shared
 * across instances. If REDIS_URL is unset (local dev), this is null and the
 * limiters fall back to express-rate-limit's in-memory store.
 *
 * Configured to fail fast and fail OPEN: when Redis is down, store commands
 * reject quickly and the limiters (passOnStoreError: true) allow the request
 * through rather than 500-ing users.
 */
const redisUrl = process.env.REDIS_URL?.trim();

function createRedisClient(): Redis | null {
  if (!redisUrl) {
    return null;
  }

  const client = new Redis(redisUrl, {
    // Fail fast rather than queueing/hanging when Redis is unreachable.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
  });

  // ioredis emits 'error' on every reconnect attempt — handle it so an
  // unhandled event can never crash the process. Report to Sentry once per
  // outage to avoid spamming.
  let sentryReported = false;
  client.on("error", (error: Error) => {
    console.error("[redis] connection error:", error.message);
    if (!sentryReported) {
      sentryReported = true;
      Sentry.captureException(error, { tags: { feature: "redis" } });
    }
  });
  client.on("ready", () => {
    if (sentryReported) {
      console.log("[redis] reconnected");
    }
    sentryReported = false;
  });

  return client;
}

export const redisClient: Redis | null = createRedisClient();
export const isRedisEnabled = redisClient !== null;

/**
 * Build a Redis-backed store for an express-rate-limit limiter, or return
 * undefined to use the default in-memory store. Each limiter must pass a unique
 * `prefix` so their counters don't collide in the shared keyspace.
 */
export function createRateLimitStore(prefix: string): Store | undefined {
  const client = redisClient;
  if (!client) {
    return undefined;
  }
  return new RedisStore({
    // ioredis `.call` runs an arbitrary command; rate-limit-redis sends its
    // Lua/INCR commands as a string argument list.
    sendCommand: (...args: string[]): Promise<RedisReply> =>
      client.call(...(args as [string, ...string[]])) as Promise<RedisReply>,
    prefix,
  });
}
