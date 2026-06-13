# Google Play Real-Time Developer Notifications (RTDN)

RTDN keeps `subscriptions` in sync with Google for lifecycle events the verify
endpoint can't see on its own (renewals, cancels, refunds, expiry, grace/hold).

> **Status:** not yet wired into the running backend. The verification endpoint
> (`/api/subscriptions/verify`) is the source of truth today. Add the endpoint
> below only after the Pub/Sub setup is complete and you've tested it with a
> Pub/Sub test push — shipping unverified billing-downgrade logic is risky.

## 1. Google Cloud Pub/Sub

1. In the Google Cloud project tied to your Play account, create a topic, e.g.
   `play-rtdn`.
2. Grant the Play publisher service account
   `google-play-developer-notifications@system.gserviceaccount.com` the
   **Pub/Sub Publisher** role on the topic.
3. Create a **push** subscription on the topic with endpoint
   `https://<your-backend>/api/webhooks/google-play` and **Enable
   authentication** (OIDC) with a service account; note the audience.

## 2. Play Console

Monetization setup → **Real-time developer notifications** → set the topic name
(`projects/<project>/topics/play-rtdn`) → Send test notification.

## 3. Backend env

- `GOOGLE_PLAY_PUBSUB_AUDIENCE` — the OIDC audience configured on the push
  subscription (your webhook URL).
- Reuses `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` / `GOOGLE_PLAY_PACKAGE_NAME`.

## 4. Reference endpoint (add + test before going live)

Mount **before** `validateAppKey` (Google won't send `x-app-key`). Principles:
verify the OIDC token; on any verification failure **ack (200) and do nothing**;
**re-verify with the Play API** before changing entitlements (never trust the
notification body alone).

```ts
// railway/backend/src/routes/playWebhook.ts
import { OAuth2Client } from "google-auth-library";
import express, { type Request, type Response } from "express";
import { verifyAndApplyByToken, downgradeByPurchaseToken } from "../services/playBilling.js";

export const playWebhookRouter = express.Router();
const oauth = new OAuth2Client();

// SubscriptionNotification.notificationType values we act on.
const RENEW = new Set([1 /*RECOVERED*/, 2 /*RENEWED*/, 4 /*PURCHASED*/, 7 /*RESTARTED*/]);
const DOWNGRADE = new Set([3 /*CANCELED→let expire*/, 12 /*REVOKED*/, 13 /*EXPIRED*/]);

playWebhookRouter.post("/google-play", express.json(), async (req: Request, res: Response) => {
  // 1) Verify the Pub/Sub OIDC token. Fail-safe: ack + ignore on any problem.
  try {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const ticket = await oauth.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE });
    if (!ticket.getPayload()?.email_verified) throw new Error("unverified");
  } catch {
    return res.status(200).end(); // ack so Pub/Sub stops retrying; do nothing
  }

  try {
    const data = req.body?.message?.data;
    if (!data) return res.status(200).end();
    const notif = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    const sub = notif.subscriptionNotification;
    if (sub?.purchaseToken && sub?.subscriptionId) {
      if (RENEW.has(sub.notificationType)) {
        // Re-verify with Play and upsert the subscription row for its owner.
        await verifyAndApplyByToken(sub.subscriptionId, sub.purchaseToken);
      } else if (DOWNGRADE.has(sub.notificationType)) {
        // Re-verify expiry/refund with Play, then set status + downgrade to free.
        await downgradeByPurchaseToken(sub.subscriptionId, sub.purchaseToken, sub.notificationType);
      }
    }
    return res.status(200).end();
  } catch (e) {
    console.error("[play-webhook]", e);
    return res.status(200).end(); // never 500 to Pub/Sub; investigate via logs
  }
});
```

`verifyAndApplyByToken` / `downgradeByPurchaseToken` are thin wrappers to add in
`playBilling.ts`: look up the row by `purchase_token` (keeping the existing
owner — `user_id` is immutable per the security migration), re-run the Play API
check, and update `subscriptions.status` + `profiles` accordingly. **Downgrade
only when the Play API confirms** expired/revoked/refunded.

## 5. Verify

- Play Console → Send test notification → backend logs show a verified, parsed
  event.
- Sandbox-cancel a tester subscription → confirm `subscriptions.status` flips and
  access ends at `expires_at`.
- Sandbox-refund → confirm immediate downgrade to free.
