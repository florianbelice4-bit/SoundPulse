import * as Sentry from "@sentry/node";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import { globalIpRateLimit } from "./middleware/globalIpRateLimit.js";
import { playWebhooksRouter } from "./routes/playWebhooks.js";
import { subscriptionsRouter } from "./routes/subscriptions.js";
import { v1Router } from "./routes/v1.js";

const sentryDsn = process.env.SENTRY_DSN?.trim();
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    tracesSampleRate: 0.2,
    sendDefaultPii: false,
    beforeSend(event) {
      // Belt-and-suspenders: never let auth/cookie headers reach Sentry.
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.Authorization;
        delete event.request.headers.cookie;
        delete event.request.headers["x-app-key"];
      }
      return event;
    },
  });
}

export const app = express();

app.set("trust proxy", 1);

app.use(helmet());

const isProduction = process.env.NODE_ENV === "production";
const envOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Native mobile requests send no Origin header — always allowed.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (envOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    if (origin === "https://soundpulse.app") {
      callback(null, true);
      return;
    }
    // Expo Go / dev-client (exp://) and localhost are dev-only — never in prod.
    if (!isProduction && (/^exp:\/\//.test(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin))) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-app-key", "x-plan-tier", "Authorization"],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));

// Google Play RTDN (Pub/Sub push) — server-to-server, authenticated by its own
// URL secret. Mounted before the IP rate limit and the app-key/JWT gates: it is
// not the mobile app, and Pub/Sub can burst from many Google IPs.
// Full path: POST /webhooks/google-play/rtdn
app.use("/webhooks", playWebhooksRouter);

// 100 req/min per IP on all Railway routes. Supabase PostgREST is called directly by
// the mobile client (not proxied here), so database API rate limits belong in Supabase.
app.use(globalIpRateLimit);

function validateAppKey(req: Request, res: Response, next: NextFunction): void {
  const expectedKey = process.env.APP_SECRET_KEY?.trim();
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !expectedKey) {
    res.status(503).json({ error: "Server misconfigured" });
    return;
  }
  if (!expectedKey) {
    next();
    return;
  }
  const raw = req.headers["x-app-key"];
  const appKey = Array.isArray(raw) ? raw[0] : raw;
  const appKeyValue = typeof appKey === "string" ? appKey : "";
  if (appKeyValue !== expectedKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/", (_req, res) => {
  res.json({ service: "soundpulse-backend", status: "ok", docs: "/v1/health" });
});

app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") {
    next();
    return;
  }
  validateAppKey(req, res, next);
});

app.use("/v1", v1Router);
app.use("/api/subscriptions", validateAppKey, subscriptionsRouter);

if (sentryDsn) {
  Sentry.setupExpressErrorHandler(app);
}
