import rateLimit from "express-rate-limit";

import { createRateLimitStore } from "../lib/redis.js";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_SIGNUPS_PER_IP = 5;

export const signupRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_SIGNUPS_PER_IP,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore("rl:signup:"),
  passOnStoreError: true,
  message: {
    error: "SIGNUP_RATE_LIMITED",
    message: "Too many sign-up attempts from this network. Try again later.",
  },
});
