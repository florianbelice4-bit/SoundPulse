# Google Play Real-Time Developer Notifications (RTDN)

RTDN keeps the `subscriptions` table and `profiles.plan` in sync with Google for
lifecycle events the verify endpoint can't see on its own — renewals, cancels,
grace/hold, pauses, refunds (revokes), and expiry.

**Status: implemented.** The webhook is live in the backend; it just needs the
Google Cloud / Play Console wiring below and one Railway env var.

- Endpoint: `POST /webhooks/google-play/rtdn?token=<PUBSUB_VERIFICATION_TOKEN>`
- Code: `routes/playWebhooks.ts` → `services/rtdn.ts` → `services/playBilling.ts`
- Audit log: `public.rtdn_events` (migration `20260611040000_rtdn_events.sql`)

## How it behaves

1. **Auth** — a shared secret in the URL (`?token=`). Missing/wrong token → `401`
   (or `503` if `PUBSUB_VERIFICATION_TOKEN` is unset). No app key, no user JWT
   (this is server-to-server from Google).
2. After auth it **always returns 2xx** so Pub/Sub doesn't retry-storm; failures
   are logged to Sentry and `rtdn_events`, not surfaced as errors.
3. It decodes the Pub/Sub `message.data`, finds the owning user by
   `purchase_token` (the bound owner — `user_id` is immutable), then:
   - **Keeps access** for active-type events (`RECOVERED 1`, `RENEWED 2`,
     `CANCELED 3`, `PURCHASED 4`, `ON_HOLD 5`, `IN_GRACE_PERIOD 6`,
     `RESTARTED 7`) by **re-verifying with the Play Developer API** and applying
     the authoritative status + `expires_at`. If Google reports the sub is
     actually inactive, it downgrades.
   - **Downgrades to free** for `PAUSED 10`, `REVOKED 12` (refund/chargeback),
     `EXPIRED 13`.
   - **Logs only** for `PRICE_CHANGE_CONFIRMED 8`, `DEFERRED 9`,
     `PAUSE_SCHEDULE_CHANGED 11`.
   - A `testNotification` is acknowledged and recorded as `ignored`.
4. Entitlement is **never** changed on a transient Play API error — only a
   definitive Google response downgrades a user.

Every delivery is recorded in `rtdn_events` (`processed` | `failed` | `ignored`)
for audit and manual retry.

## 1. Google Cloud Console

1. In the Google Cloud project linked to your Play account, create a Pub/Sub
   **topic**: `soundpulse-rtdn`.
2. Grant the Play publisher service account
   `google-play-developer-notifications@system.gserviceaccount.com` the
   **Pub/Sub Publisher** role on that topic.
3. Create a **Push** subscription on the topic:
   - **Endpoint URL:**
     `https://<your-railway-host>/webhooks/google-play/rtdn?token=<SECRET>`
     (use the same `<SECRET>` you set in Railway below).
   - **Acknowledgement deadline:** 10 seconds.
   - **Message retention:** 7 days.
   - Enabling OIDC "authentication" on the push subscription is optional and not
     required — the URL token is the auth mechanism this endpoint checks.

## 2. Play Console

Monetization → **Monetization setup** → **Real-time developer notifications**:
- **Topic name:** `projects/<your-gcp-project>/topics/soundpulse-rtdn`
- Click **Send test notification** to verify delivery.

## 3. Railway env var

- `PUBSUB_VERIFICATION_TOKEN` — a long random string. Must match the `token=`
  value in the Pub/Sub push endpoint URL.
- Reuses the existing `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` and
  `GOOGLE_PLAY_PACKAGE_NAME` for the Play API re-verification.

## 4. Supabase

Run migration `supabase/migrations/20260611040000_rtdn_events.sql` (creates
`rtdn_events`, RLS-on / no-policy → service-role only).

## Test plan

1. **Test notification:** Play Console → Send test notification. Expect HTTP 200
   and a new `rtdn_events` row with `status = 'ignored'` (`error_message = 'test
   notification'`).
2. **Bad token:** `curl -X POST 'https://<host>/webhooks/google-play/rtdn?token=wrong'`
   → `401`, no row written.
3. **Renewal:** with a Play sandbox subscriber, let it auto-renew. Expect a
   `RENEWED` row `status = 'processed'` and `subscriptions.expires_at` advanced.
4. **Cancel:** cancel in the Play Store. Expect a `CANCELED` row; access remains
   until `expires_at` (status `canceled`).
5. **Revoke/refund:** refund the order in Play Console. Expect a `REVOKED` row
   and the user immediately on `plan = 'free'`, `subscription_active = false`.
6. **Expiry:** after a sandbox subscription lapses, expect an `EXPIRED` row and a
   downgrade to free.
7. **Audit:** `SELECT notification_type, status, error_message, processed_at FROM
   rtdn_events ORDER BY processed_at DESC LIMIT 20;`

## Notes

- Pub/Sub delivers at-least-once; duplicate deliveries are safe — processing is
  idempotent (re-verify + apply the same state) and each delivery is logged.
- The mobile `/api/subscriptions/verify` flow is unchanged and remains the path
  that first creates a subscription row; RTDN keeps it current afterward.
