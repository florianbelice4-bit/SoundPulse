import rateLimit from "express-rate-limit";

import { createRateLimitStore } from "../lib/redis.js";

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_IP = 100;

/** Applies to every request before route handlers (100/min per IP). */
export const globalIpRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS_PER_IP,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore("rl:global:"),
  // Fail open: if Redis errors, allow the request instead of 500-ing.
  passOnStoreError: true,
  message: {
    error: "GLOBAL_RATE_LIMIT_EXCEEDED",
    message: "Too many requests from this network. Try again shortly.",
  },
});
