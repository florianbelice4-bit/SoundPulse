import * as Sentry from "@sentry/node";
import express, { type Request, type Response } from "express";

import { decodeRtdnMessage, processRtdnNotification } from "../services/rtdn.js";

export const playWebhooksRouter = express.Router();

/**
 * Google Play Real-Time Developer Notifications (Pub/Sub push).
 * POST /webhooks/google-play/rtdn?token=<PUBSUB_VERIFICATION_TOKEN>
 *
 * Server-to-server: no app key, no user JWT. Authenticated by a shared secret
 * in the URL (configured on the Pub/Sub push subscription). After auth we always
 * ack (2xx) so Pub/Sub doesn't retry-storm; failures are logged, not surfaced.
 */
playWebhooksRouter.post("/google-play/rtdn", async (req: Request, res: Response) => {
  const expected = process.env.PUBSUB_VERIFICATION_TOKEN?.trim();
  if (!expected) {
    // Refuse to accept unauthenticated webhooks if the secret isn't configured.
    console.error("[rtdn] PUBSUB_VERIFICATION_TOKEN is not set");
    res.status(503).end();
    return;
  }

  const provided = typeof req.query.token === "string" ? req.query.token : "";
  if (provided !== expected) {
    res.status(401).end();
    return;
  }

  const notification = decodeRtdnMessage(req.body);
  if (!notification) {
    // Authenticated but nothing to process (empty/malformed) — ack so Pub/Sub
    // stops retrying.
    res.status(204).end();
    return;
  }

  try {
    await processRtdnNotification(notification);
  } catch (error) {
    // processRtdnNotification handles its own errors; this is a final backstop.
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { feature: "rtdn" },
    });
    console.error("[rtdn] unhandled processing error:", error);
  }

  res.status(200).end();
});
