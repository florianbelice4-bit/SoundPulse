import * as Sentry from "@sentry/node";
import { google } from "googleapis";
import type { androidpublisher_v3 } from "googleapis";

import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import type { PlanTier } from "./planTier.js";
import {
  isKnownPlayProductId,
  isPlayLifetimeProduct,
  isPlaySubscriptionProduct,
  playProductIdToTier,
} from "./playProducts.js";

export class PlayBillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayBillingConfigError";
  }
}

/** A purchase token already belongs to a different SoundPulse account. */
export class PlayPurchaseOwnershipError extends Error {
  constructor(message = "This purchase is already linked to another account.") {
    super(message);
    this.name = "PlayPurchaseOwnershipError";
  }
}

export class PlayPurchaseVerificationError extends Error {
  readonly refunded: boolean;

  constructor(message: string, refunded = false) {
    super(message);
    this.name = "PlayPurchaseVerificationError";
    this.refunded = refunded;
  }
}

function getPackageName(): string {
  return process.env.GOOGLE_PLAY_PACKAGE_NAME?.trim() || "com.soundpulseapp.android";
}

function getAndroidPublisher(): androidpublisher_v3.Androidpublisher {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    throw new PlayBillingConfigError(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not configured on the server."
    );
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new PlayBillingConfigError("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  return google.androidpublisher({ version: "v3", auth });
}

const ACTIVE_SUBSCRIPTION_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
]);

type VerifiedPurchaseDetails = {
  status: "active" | "in_grace_period" | "canceled";
  expiresAt: string | null;
  autoRenewing: boolean | null;
  packageName: string;
  productId: string;
  purchaseToken: string;
};

export type VerifiedPlayPurchaseResult = VerifiedPurchaseDetails & {
  tier: PlanTier;
};

function statusFromSubscriptionState(state: string): VerifiedPurchaseDetails["status"] {
  if (state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") {
    return "in_grace_period";
  }
  if (state === "SUBSCRIPTION_STATE_CANCELED") {
    return "canceled";
  }
  return "active";
}

function assertUnexpired(expiresAt: string | null): void {
  if (!expiresAt) {
    return;
  }
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    throw new PlayPurchaseVerificationError("Subscription has expired.");
  }
}

async function verifySubscriptionPurchase(
  publisher: androidpublisher_v3.Androidpublisher,
  packageName: string,
  productId: string,
  purchaseToken: string
): Promise<VerifiedPurchaseDetails> {
  try {
    const { data } = await publisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });

    const state = data.subscriptionState ?? "";
    if (!ACTIVE_SUBSCRIPTION_STATES.has(state)) {
      throw new PlayPurchaseVerificationError(
        `Subscription is not active (state: ${state || "unknown"}).`
      );
    }

    const lineItems = data.lineItems ?? [];
    const matchingLine = lineItems.find((item) => item.productId === productId);
    if (lineItems.length > 0 && !matchingLine) {
      throw new PlayPurchaseVerificationError(
        `Purchase token does not match product ${productId}.`
      );
    }

    const testPurchase = (data as { testPurchase?: unknown }).testPurchase;
    if (
      testPurchase &&
      process.env.NODE_ENV === "production" &&
      process.env.ALLOW_PLAY_TEST_PURCHASES !== "true"
    ) {
      throw new PlayPurchaseVerificationError("Test purchases are not allowed in production.");
    }

    const line = matchingLine ?? lineItems[0];
    const expiresAt = line?.expiryTime ?? null;
    assertUnexpired(expiresAt);

    return {
      status: statusFromSubscriptionState(state),
      expiresAt,
      autoRenewing: line?.autoRenewingPlan?.autoRenewEnabled ?? null,
      packageName,
      productId,
      purchaseToken,
    };
  } catch (err) {
    if (err instanceof PlayPurchaseVerificationError) {
      throw err;
    }

    const status =
      err && typeof err === "object" && "code" in err ? Number((err as { code: unknown }).code) : 0;
    if (status !== 404) {
      throw err;
    }
  }

  const { data: legacy } = await publisher.purchases.subscriptions.get({
    packageName,
    subscriptionId: productId,
    token: purchaseToken,
  });

  const paymentState = legacy.paymentState ?? -1;
  if (paymentState !== 1 && paymentState !== 2) {
    throw new PlayPurchaseVerificationError(
      `Subscription payment not received (paymentState=${String(paymentState)}).`
    );
  }

  if (legacy.cancelReason != null && legacy.cancelReason !== 0) {
    const expiresAt = legacy.expiryTimeMillis
      ? new Date(Number(legacy.expiryTimeMillis)).toISOString()
      : null;
    assertUnexpired(expiresAt);
    return {
      status: "canceled",
      expiresAt,
      autoRenewing: Boolean(legacy.autoRenewing),
      packageName,
      productId,
      purchaseToken,
    };
  }

  const expiresAt = legacy.expiryTimeMillis
    ? new Date(Number(legacy.expiryTimeMillis)).toISOString()
    : null;
  assertUnexpired(expiresAt);
  return {
    status: "active",
    expiresAt,
    autoRenewing: Boolean(legacy.autoRenewing),
    packageName,
    productId,
    purchaseToken,
  };
}

async function verifyOneTimeProductPurchase(
  publisher: androidpublisher_v3.Androidpublisher,
  packageName: string,
  productId: string,
  purchaseToken: string
): Promise<VerifiedPurchaseDetails> {
  const { data } = await publisher.purchases.products.get({
    packageName,
    productId,
    token: purchaseToken,
  });

  if (data.purchaseState !== 0) {
    throw new PlayPurchaseVerificationError(
      `Product purchase is not completed (purchaseState=${String(data.purchaseState)}).`
    );
  }

  if (data.productId && data.productId !== productId) {
    throw new PlayPurchaseVerificationError("Product ID mismatch.");
  }

  return {
    status: "active",
    expiresAt: "2099-01-01T00:00:00.000Z",
    autoRenewing: false,
    packageName,
    productId,
    purchaseToken,
  };
}

export async function applyVerifiedTierToProfile(
  userId: string,
  tier: PlanTier,
  purchase: VerifiedPurchaseDetails
): Promise<void> {
  // Bind the purchase token to its first account. A token already owned by a
  // different user must NOT be reassigned — otherwise one subscription could be
  // moved/hijacked across accounts by replaying the token.
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("subscriptions")
    .select("id, user_id")
    .eq("purchase_token", purchase.purchaseToken)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Failed to look up subscription: ${lookupError.message}`);
  }

  if (existing && existing.user_id && existing.user_id !== userId) {
    Sentry.captureMessage("subscription_hijack_attempt", {
      level: "warning",
      tags: { feature: "billing", product_id: purchase.productId },
    });
    throw new PlayPurchaseOwnershipError();
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      plan: tier,
      subscription_tier: tier,
      subscription_active: true,
      subscription_status: purchase.status,
    })
    .eq("id", userId);

  if (error) {
    throw new Error(`Failed to update profile: ${error.message}`);
  }

  const row = {
    user_id: userId,
    plan: tier,
    status: purchase.status,
    expires_at: purchase.expiresAt,
    product_id: purchase.productId,
    purchase_token: purchase.purchaseToken,
    package_name: purchase.packageName,
    auto_renewing: purchase.autoRenewing,
    updated_at: new Date().toISOString(),
  };

  const write = existing?.id
    ? supabaseAdmin.from("subscriptions").update(row).eq("id", existing.id)
    : supabaseAdmin.from("subscriptions").insert(row);

  const { error: subscriptionError } = await write;

  if (subscriptionError) {
    throw new Error(`Failed to record subscription: ${subscriptionError.message}`);
  }

  if (tier === "lifetime") {
    const { error: lifetimeErr } = await supabaseAdmin.from("lifetime_purchases").insert({
      user_id: userId,
    });
    if (lifetimeErr) {
      console.warn("[playBilling] lifetime_purchases insert:", lifetimeErr.message);
    }
  }
}

/**
 * Revoke or refund a purchase that failed server verification.
 * Subscriptions are revoked; one-time products are refunded when orderId is available.
 */
export async function rejectUnverifiedPlayPurchase(
  productId: string,
  purchaseToken: string
): Promise<boolean> {
  let publisher: androidpublisher_v3.Androidpublisher;
  try {
    publisher = getAndroidPublisher();
  } catch (e) {
    console.error("[playBilling] reject skipped — config:", e);
    return false;
  }

  const packageName = getPackageName();

  try {
    if (isPlayLifetimeProduct(productId)) {
      const { data } = await publisher.purchases.products.get({
        packageName,
        productId,
        token: purchaseToken,
      });
      const orderId = data.orderId;
      if (orderId) {
        await publisher.orders.refund({
          packageName,
          orderId,
          revoke: true,
        });
        console.log("[playBilling] Refunded one-time order", orderId);
        return true;
      }
      console.warn("[playBilling] No orderId for one-time purchase; client must not acknowledge.");
      return false;
    }

    if (isPlaySubscriptionProduct(productId)) {
      await publisher.purchases.subscriptions.revoke({
        packageName,
        subscriptionId: productId,
        token: purchaseToken,
      });
      console.log("[playBilling] Revoked subscription", productId);
      return true;
    }
  } catch (e) {
    console.error("[playBilling] reject/refund failed:", e);
    return false;
  }

  return false;
}

/**
 * Verify purchase with Google Play Developer API, then grant entitlements in Supabase.
 */
export async function verifyAndGrantPlayPurchase(
  userId: string,
  productId: string,
  purchaseToken: string,
  clientPackageName?: string
): Promise<VerifiedPlayPurchaseResult> {
  if (!isKnownPlayProductId(productId)) {
    throw new PlayPurchaseVerificationError(`Unknown product ID: ${productId}`);
  }

  const tier = playProductIdToTier(productId);
  if (!tier) {
    throw new PlayPurchaseVerificationError(`No plan tier mapped for ${productId}`);
  }

  const token = purchaseToken.trim();
  if (!token) {
    throw new PlayPurchaseVerificationError("Missing purchase token.");
  }

  const publisher = getAndroidPublisher();
  const packageName = getPackageName();
  const submittedPackageName = clientPackageName?.trim();
  if (submittedPackageName && submittedPackageName !== packageName) {
    throw new PlayPurchaseVerificationError("Package name does not match this app.");
  }

  try {
    let verified: VerifiedPurchaseDetails;
    if (isPlayLifetimeProduct(productId)) {
      verified = await verifyOneTimeProductPurchase(publisher, packageName, productId, token);
    } else if (isPlaySubscriptionProduct(productId)) {
      verified = await verifySubscriptionPurchase(publisher, packageName, productId, token);
    } else {
      throw new PlayPurchaseVerificationError(`Unsupported product type: ${productId}`);
    }

    await applyVerifiedTierToProfile(userId, tier, verified);
    return { ...verified, tier };
  } catch (err) {
    // A token bound to another account is a VALID purchase applied to the wrong
    // user — never refund/revoke it. Surface the conflict as-is.
    if (err instanceof PlayPurchaseOwnershipError) {
      throw err;
    }
    const refunded = await rejectUnverifiedPlayPurchase(productId, token);
    if (err instanceof PlayPurchaseVerificationError) {
      throw new PlayPurchaseVerificationError(err.message, refunded);
    }
    throw new PlayPurchaseVerificationError(
      err instanceof Error ? err.message : "Purchase verification failed.",
      refunded
    );
  }
}

/**
 * Re-verify a known subscription with Google and apply its authoritative state
 * to the user. Used by RTDN for renewals/cancels/grace events.
 *
 * Unlike verifyAndGrantPlayPurchase, this does NOT refund/revoke on failure: a
 * transient API error must never void a valid purchase. A genuine inactive state
 * surfaces as PlayPurchaseVerificationError for the caller to act on (downgrade).
 */
export async function refreshPlaySubscription(
  userId: string,
  productId: string,
  purchaseToken: string
): Promise<VerifiedPlayPurchaseResult> {
  const tier = playProductIdToTier(productId);
  if (!tier) {
    throw new PlayPurchaseVerificationError(`No plan tier mapped for ${productId}`);
  }
  const publisher = getAndroidPublisher();
  const packageName = getPackageName();
  const verified = await verifySubscriptionPurchase(publisher, packageName, productId, purchaseToken.trim());
  await applyVerifiedTierToProfile(userId, tier, verified);
  return { ...verified, tier };
}

/**
 * Drop a user to the free plan and stamp the terminal status on their
 * subscription row (revoked/expired/paused). Used by RTDN downgrade events.
 */
export async function downgradePlaySubscription(
  userId: string,
  purchaseToken: string,
  status: string
): Promise<void> {
  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({
      plan: "free",
      subscription_tier: "free",
      subscription_active: false,
      subscription_status: status,
    })
    .eq("id", userId);
  if (profileError) {
    throw new Error(`Failed to downgrade profile: ${profileError.message}`);
  }

  const { error: subscriptionError } = await supabaseAdmin
    .from("subscriptions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("purchase_token", purchaseToken)
    .eq("user_id", userId);
  if (subscriptionError) {
    throw new Error(`Failed to downgrade subscription: ${subscriptionError.message}`);
  }
}
