import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

import { createRateLimitStore } from "../lib/redis.js";

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 8;

export const generateRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore("rl:generate:"),
  passOnStoreError: true,
  keyGenerator: (req: Request) => {
    if (req.user?.id) {
      return req.user.id;
    }
    return req.ip ? ipKeyGenerator(req.ip) : "anonymous";
  },
  message: { error: "RATE_LIMIT_EXCEEDED" },
});
