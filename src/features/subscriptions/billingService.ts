import Constants from "expo-constants";
import {
  fetchProducts as fetchStoreProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  restorePurchases as restoreStorePurchases,
  type ProductSubscription,
  type Purchase,
  type ExpoPurchaseError,
} from "expo-iap";
import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";

import { backendJsonHeaders, ensureBackendUrl } from "@/src/lib/backend";
import { sanitizedErrorReason, trackEvent } from "@/src/lib/analytics";
import { fetchWithTimeout } from "@/src/lib/fetchWithTimeout";
import { supabase } from "@/src/lib/supabase";

import {
  BILLING_PRODUCT_ID_LIST,
  PRODUCT_TO_PLAN,
  type BillingPlanId,
  planForProductId,
} from "./billingConfig";

export type BillingProduct = ProductSubscription;

export type BillingVerificationResult = {
  ok: boolean;
  plan: BillingPlanId;
  tier: BillingPlanId;
  productId: string;
  status: string;
  expiresAt: string | null;
};

export type BillingSubscriptionRow = {
  plan: string | null;
  status: string | null;
  expires_at: string | null;
  product_id?: string | null;
};

type PurchaseListenerHandlers = {
  onSuccess?: (result: BillingVerificationResult, purchase: Purchase) => void;
  onPending?: (purchase: Purchase) => void;
  onError?: (error: Error) => void;
};

const ACTIVE_STATUSES = new Set(["active", "trialing", "in_grace_period", "canceled"]);
const PRODUCT_ORDER: Map<string, number> = new Map(
  BILLING_PRODUCT_ID_LIST.map((id, index) => [id, index])
);

let connectionPromise: Promise<boolean> | null = null;
let cachedProducts: BillingProduct[] = [];

function normalizeBillingError(error: unknown, fallback = "Billing failed. Please try again."): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return new Error(String((error as { message?: unknown }).message || fallback));
  }
  return new Error(fallback);
}

function messageForPurchaseError(error: ExpoPurchaseError): string {
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  if (code.includes("user-cancelled")) {
    return "Purchase was cancelled.";
  }
  if (code.includes("network") || code.includes("service-disconnected")) {
    return "Billing service is unavailable. Check your connection and try again.";
  }
  if (code.includes("already-owned")) {
    return "This subscription is already active for your Google Play account.";
  }
  return error.message || "Purchase failed. Please try again.";
}

function captureBillingError(error: unknown, phase: string, productId?: string): void {
  const normalized = normalizeBillingError(error);
  Sentry.captureException(normalized, {
    tags: {
      feature: "billing",
      billing_phase: phase,
    },
    contexts: {
      billing: {
        productId: productId ?? "unknown",
      },
    },
  });
}

function getPackageName(purchase?: Purchase): string {
  const androidPackage =
    purchase && "packageNameAndroid" in purchase ? purchase.packageNameAndroid : undefined;
  const configured = Constants.expoConfig?.android?.package;
  return androidPackage?.trim() || configured?.trim() || "com.soundpulseapp.android";
}

function isBillingProduct(product: unknown): product is BillingProduct {
  return (
    typeof product === "object" &&
    product !== null &&
    (product as ProductSubscription).type === "subs" &&
    typeof (product as ProductSubscription).id === "string" &&
    (product as ProductSubscription).id in PRODUCT_TO_PLAN
  );
}

function isBillingPurchase(purchase: Purchase): boolean {
  return typeof purchase.productId === "string" && purchase.productId in PRODUCT_TO_PLAN;
}

function selectAndroidOffer(product: BillingProduct): { sku: string; offerToken: string } | null {
  const offer = product.subscriptionOffers?.find((item) => item.offerTokenAndroid);
  if (offer?.offerTokenAndroid) {
    return { sku: product.id, offerToken: offer.offerTokenAndroid };
  }

  const legacyOffer =
    product.platform === "android" ? product.subscriptionOfferDetailsAndroid?.[0]?.offerToken : null;
  return legacyOffer ? { sku: product.id, offerToken: legacyOffer } : null;
}

export function isActiveSubscription(row: BillingSubscriptionRow | null | undefined): boolean {
  if (!row) {
    return false;
  }
  const plan = row.plan?.trim().toLowerCase() ?? "";
  const status = row.status?.trim().toLowerCase() ?? "";
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const stillEntitled = !expiresAt || expiresAt.getTime() > Date.now();
  return Boolean(plan && plan !== "free" && ACTIVE_STATUSES.has(status) && stillEntitled);
}

export async function initializeBilling(): Promise<boolean> {
  if (Platform.OS !== "android") {
    throw new Error("Google Play Billing is only available in Android builds.");
  }

  if (!connectionPromise) {
    connectionPromise = initConnection().catch((error) => {
      connectionPromise = null;
      captureBillingError(error, "initialize");
      throw error;
    });
  }

  return connectionPromise;
}

export async function getAvailableProducts(): Promise<BillingProduct[]> {
  await initializeBilling();

  const products = await fetchStoreProducts({
    skus: [...BILLING_PRODUCT_ID_LIST],
    type: "subs",
  }).catch((error) => {
    captureBillingError(error, "fetch_products");
    throw error;
  });

  cachedProducts = (products ?? [])
    .filter(isBillingProduct)
    .sort((a, b) => (PRODUCT_ORDER.get(a.id) ?? 0) - (PRODUCT_ORDER.get(b.id) ?? 0));

  return cachedProducts;
}

export async function purchaseSubscription(productId: string): Promise<void> {
  if (!(productId in PRODUCT_TO_PLAN)) {
    throw new Error("This subscription is not available.");
  }

  await initializeBilling();
  const products = cachedProducts.length > 0 ? cachedProducts : await getAvailableProducts();
  const product = products.find((item) => item.id === productId);
  if (!product) {
    throw new Error("Could not load this Google Play subscription.");
  }

  if (Platform.OS === "android") {
    const offer = selectAndroidOffer(product);
    await requestPurchase({
      type: "subs",
      request: {
        google: {
          skus: [productId],
          subscriptionOffers: offer ? [offer] : undefined,
        },
      },
    });
    return;
  }

  await requestPurchase({
    type: "subs",
    request: {
      apple: { sku: productId },
    },
  });
}

async function getCurrentUserSession(): Promise<{ userId: string; accessToken: string }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user?.id || !session.access_token) {
    throw new Error("Sign in to manage subscriptions.");
  }

  return { userId: session.user.id, accessToken: session.access_token };
}

export async function verifyPurchaseWithBackend(purchase: Purchase): Promise<BillingVerificationResult> {
  const plan = planForProductId(purchase.productId);
  if (!plan) {
    throw new Error("This purchase is not a SoundPulse subscription.");
  }

  const purchaseToken = purchase.purchaseToken?.trim();
  if (!purchaseToken) {
    throw new Error("Google Play did not return a purchase token.");
  }

  const { userId, accessToken } = await getCurrentUserSession();
  const baseUrl = ensureBackendUrl();
  const response = await fetchWithTimeout(`${baseUrl}/api/subscriptions/verify`, {
    method: "POST",
    headers: backendJsonHeaders(accessToken),
    body: JSON.stringify({
      userId,
      productId: purchase.productId,
      purchaseToken,
      packageName: getPackageName(purchase),
    }),
    timeoutMs: 30000,
  });

  const text = await response.text();
  let parsed: Partial<BillingVerificationResult> & { error?: unknown; message?: string } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* non-json */
  }

  if (!response.ok || parsed.ok === false) {
    const message =
      parsed.message ||
      (typeof parsed.error === "string" ? parsed.error : "") ||
      `Purchase verification failed (${response.status})`;
    throw new Error(message);
  }

  return {
    ok: true,
    plan,
    tier: plan,
    productId: purchase.productId,
    status: typeof parsed.status === "string" ? parsed.status : "active",
    expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
  };
}

export async function handlePurchaseUpdate(purchase: Purchase): Promise<BillingVerificationResult | null> {
  if (!isBillingPurchase(purchase)) {
    return null;
  }

  if (purchase.purchaseState === "pending") {
    return null;
  }
  if (purchase.purchaseState !== "purchased") {
    throw new Error("Purchase was not completed.");
  }

  const result = await verifyPurchaseWithBackend(purchase);
  await finishTransaction({ purchase, isConsumable: false });
  void trackEvent("subscription_purchased", {
    plan: result.plan,
    product_id: purchase.productId,
  });
  return result;
}

export async function restorePurchases(): Promise<BillingVerificationResult[]> {
  await initializeBilling();
  await restoreStorePurchases();
  const purchases = await getAvailablePurchases();
  const results: BillingVerificationResult[] = [];

  for (const purchase of purchases.filter(isBillingPurchase)) {
    try {
      const result = await handlePurchaseUpdate(purchase);
      if (result) {
        results.push(result);
      }
    } catch (error) {
      captureBillingError(error, "restore_purchase", purchase.productId);
    }
  }

  if (results.length > 0) {
    void trackEvent("subscription_purchased", {
      plan: results[0]?.plan ?? null,
      restored: true,
    });
  }

  return results;
}

export async function getCurrentSubscription(): Promise<BillingSubscriptionRow | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.id) {
    return null;
  }

  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan,status,expires_at,product_id")
    .eq("user_id", user.id)
    .order("expires_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? [])[0] as BillingSubscriptionRow | undefined) ?? null;
}

export function subscribeToPurchaseUpdates(handlers: PurchaseListenerHandlers): () => void {
  const successSub = purchaseUpdatedListener((purchase) => {
    void (async () => {
      try {
        if (purchase.purchaseState === "pending") {
          handlers.onPending?.(purchase);
          return;
        }
        const result = await handlePurchaseUpdate(purchase);
        if (result) {
          handlers.onSuccess?.(result, purchase);
        }
      } catch (error) {
        captureBillingError(error, "purchase_update", purchase.productId);
        handlers.onError?.(normalizeBillingError(error));
      }
    })();
  });

  const errorSub = purchaseErrorListener((error: ExpoPurchaseError) => {
    const message = messageForPurchaseError(error);
    const normalized = new Error(message);
    captureBillingError(normalized, "purchase_error", error.productId);
    handlers.onError?.(normalized);
  });

  return () => {
    successSub.remove();
    errorSub.remove();
  };
}

export function billingErrorMessage(error: unknown): string {
  const normalized = normalizeBillingError(error);
  return sanitizedErrorReason(normalized.message) === "unknown"
    ? "Billing failed. Please try again."
    : normalized.message;
}
