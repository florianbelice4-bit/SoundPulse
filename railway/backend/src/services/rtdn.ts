import * as Sentry from "@sentry/node";

import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import {
  downgradePlaySubscription,
  PlayPurchaseVerificationError,
  refreshPlaySubscription,
} from "./playBilling.js";

/**
 * Google Play subscription notification types.
 * https://developer.android.com/google/play/billing/rtdn-reference
 */
const SUBSCRIPTION_RECOVERED = 1;
const SUBSCRIPTION_RENEWED = 2;
const SUBSCRIPTION_CANCELED = 3;
const SUBSCRIPTION_PURCHASED = 4;
const SUBSCRIPTION_ON_HOLD = 5;
const SUBSCRIPTION_IN_GRACE_PERIOD = 6;
const SUBSCRIPTION_RESTARTED = 7;
const SUBSCRIPTION_PRICE_CHANGE_CONFIRMED = 8;
const SUBSCRIPTION_DEFERRED = 9;
const SUBSCRIPTION_PAUSED = 10;
const SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED = 11;
const SUBSCRIPTION_REVOKED = 12;
const SUBSCRIPTION_EXPIRED = 13;

// Types where the user should still be entitled — re-verify with Google and
// apply the authoritative state (Recovered/Renewed/Purchased/Grace/Hold/
// Restarted/Canceled-but-not-yet-expired).
const KEEP_ENTITLED = new Set<number>([
  SUBSCRIPTION_RECOVERED,
  SUBSCRIPTION_RENEWED,
  SUBSCRIPTION_CANCELED,
  SUBSCRIPTION_PURCHASED,
  SUBSCRIPTION_ON_HOLD,
  SUBSCRIPTION_IN_GRACE_PERIOD,
  SUBSCRIPTION_RESTARTED,
]);

// Terminal/no-access types → drop to free, recording the status.
const DOWNGRADE_STATUS: Record<number, string> = {
  [SUBSCRIPTION_PAUSED]: "paused",
  [SUBSCRIPTION_REVOKED]: "revoked",
  [SUBSCRIPTION_EXPIRED]: "expired",
};

// Informational only — log, no entitlement change.
const LOG_ONLY = new Set<number>([
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED,
  SUBSCRIPTION_DEFERRED,
  SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED,
]);

type SubscriptionNotification = {
  notificationType?: number;
  purchaseToken?: string;
  subscriptionId?: string;
};

export type DeveloperNotification = {
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: SubscriptionNotification;
  testNotification?: { version?: string };
  oneTimeProductNotification?: unknown;
  voidedPurchaseNotification?: unknown;
};

type RtdnEventRow = {
  notification_type: number;
  purchase_token: string;
  subscription_id?: string | null;
  event_time_millis?: number | null;
  raw_payload: unknown;
  status: "processed" | "failed" | "ignored";
  error_message?: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decode the base64 `message.data` of a Pub/Sub push into a notification. */
export function decodeRtdnMessage(body: unknown): DeveloperNotification | null {
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== "string" || data.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as DeveloperNotification;
  } catch {
    return null;
  }
}

async function logRtdnEvent(row: RtdnEventRow): Promise<void> {
  // Audit logging is best-effort and must never break the webhook response.
  const { error } = await supabaseAdmin.from("rtdn_events").insert(row);
  if (error) {
    console.error("[rtdn] failed to log event:", error.message);
  }
}

/**
 * Process one decoded RTDN. Looks up the owning user by purchase token, applies
 * the entitlement change via the Play API, and records an audit row. Never
 * throws — failures are logged to Sentry and the rtdn_events table.
 */
export async function processRtdnNotification(notification: DeveloperNotification): Promise<void> {
  // Play "send test notification" — acknowledge without touching entitlements.
  if (notification.testNotification) {
    await logRtdnEvent({
      notification_type: 0,
      purchase_token: "test",
      raw_payload: notification,
      status: "ignored",
      error_message: "test notification",
    });
    return;
  }

  const sub = notification.subscriptionNotification;
  const purchaseToken = typeof sub?.purchaseToken === "string" ? sub.purchaseToken : "";
  const productId = typeof sub?.subscriptionId === "string" ? sub.subscriptionId : "";
  const notificationType = typeof sub?.notificationType === "number" ? sub.notificationType : -1;
  const eventTimeMillis =
    typeof notification.eventTimeMillis === "string" && notification.eventTimeMillis
      ? Number(notification.eventTimeMillis)
      : null;

  if (!purchaseToken) {
    // oneTimeProduct / voided / malformed — nothing subscription-related to do.
    await logRtdnEvent({
      notification_type: notificationType,
      purchase_token: "n/a",
      raw_payload: notification,
      status: "ignored",
      error_message: "no subscriptionNotification.purchaseToken",
    });
    return;
  }

  const base = {
    notification_type: notificationType,
    purchase_token: purchaseToken,
    subscription_id: productId || null,
    event_time_millis: Number.isFinite(eventTimeMillis) ? eventTimeMillis : null,
    raw_payload: notification,
  };

  // Resolve the owner from the bound subscription row (user_id is immutable).
  const { data: row, error: lookupError } = await supabaseAdmin
    .from("subscriptions")
    .select("user_id")
    .eq("purchase_token", purchaseToken)
    .maybeSingle();

  if (lookupError) {
    Sentry.captureException(new Error(`rtdn lookup failed: ${lookupError.message}`), {
      tags: { feature: "rtdn", notification_type: String(notificationType) },
    });
    await logRtdnEvent({ ...base, status: "failed", error_message: `lookup: ${lookupError.message}` });
    return;
  }

  const userId = typeof row?.user_id === "string" ? row.user_id : "";
  if (!userId) {
    // No row yet (e.g. a notification racing the client's verify call). The
    // client's own verification is the source of truth, so just record it.
    await logRtdnEvent({ ...base, status: "ignored", error_message: "no subscription row for token" });
    return;
  }

  try {
    if (LOG_ONLY.has(notificationType)) {
      await logRtdnEvent({ ...base, status: "processed" });
      return;
    }

    const downgradeStatus = DOWNGRADE_STATUS[notificationType];
    if (downgradeStatus) {
      await downgradePlaySubscription(userId, purchaseToken, downgradeStatus);
      await logRtdnEvent({ ...base, status: "processed" });
      return;
    }

    if (KEEP_ENTITLED.has(notificationType)) {
      try {
        await refreshPlaySubscription(userId, productId, purchaseToken);
        await logRtdnEvent({ ...base, status: "processed" });
      } catch (verifyError) {
        if (verifyError instanceof PlayPurchaseVerificationError) {
          // Google confirms the subscription is no longer valid → downgrade.
          await downgradePlaySubscription(userId, purchaseToken, "expired");
          await logRtdnEvent({
            ...base,
            status: "processed",
            error_message: `Google reports inactive; downgraded: ${verifyError.message}`,
          });
        } else {
          // Transient (network/API) — do NOT change entitlement; allow retry.
          throw verifyError;
        }
      }
      return;
    }

    await logRtdnEvent({ ...base, status: "ignored", error_message: `unhandled type ${notificationType}` });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(errorMessage(error)), {
      tags: { feature: "rtdn", notification_type: String(notificationType) },
    });
    await logRtdnEvent({ ...base, status: "failed", error_message: errorMessage(error) });
  }
}
