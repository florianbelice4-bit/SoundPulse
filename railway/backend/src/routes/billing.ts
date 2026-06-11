import express, { type Request, type Response } from "express";

import { authenticateUser } from "../middleware/authenticateUser.js";
import { billingRestoreRateLimit, billingVerifyRateLimit } from "../middleware/userRateLimit.js";
import {
  PlayBillingConfigError,
  PlayPurchaseOwnershipError,
  PlayPurchaseVerificationError,
  verifyAndGrantPlayPurchase,
} from "../services/playBilling.js";
import { isKnownPlayProductId, playProductIdToTier } from "../services/playProducts.js";
import type { PlanTier } from "../services/planTier.js";

export const billingRouter = express.Router();

type VerifyBody = {
  productId?: unknown;
  purchaseToken?: unknown;
  packageName?: unknown;
};

type RestorePurchaseInput = {
  productId?: unknown;
  purchaseToken?: unknown;
};

const TIER_RANK: Record<PlanTier, number> = {
  free: 0,
  basic: 1,
  pro_weekly: 1,
  student: 1,
  semester: 1,
  pro: 4,
  yearly: 5,
  unlimited: 6,
  lifetime: 7,
};

function parseVerifyBody(body: VerifyBody): { productId: string; purchaseToken: string; packageName?: string } | null {
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  const purchaseToken = typeof body.purchaseToken === "string" ? body.purchaseToken.trim() : "";
  const packageName = typeof body.packageName === "string" ? body.packageName.trim() : "";
  if (!productId || !purchaseToken) {
    return null;
  }
  return { productId, purchaseToken, packageName: packageName || undefined };
}

function sendBillingError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) {
  res.status(status).json({ error: { code, message }, ...extra });
}

billingRouter.post("/play/verify", authenticateUser, billingVerifyRateLimit, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    sendBillingError(res, 401, "UNAUTHORIZED", "Unauthorized");
    return;
  }

  const parsed = parseVerifyBody(req.body as VerifyBody);
  if (!parsed) {
    sendBillingError(res, 400, "INVALID_REQUEST", "productId and purchaseToken are required.");
    return;
  }

  if (!isKnownPlayProductId(parsed.productId)) {
    sendBillingError(res, 400, "UNKNOWN_PRODUCT", `Unknown product ID: ${parsed.productId}`);
    return;
  }

  try {
    const result = await verifyAndGrantPlayPurchase(
      userId,
      parsed.productId,
      parsed.purchaseToken,
      parsed.packageName
    );
    res.json({
      ok: true,
      tier: result.tier,
      plan: result.tier,
      productId: parsed.productId,
      status: result.status,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    if (err instanceof PlayBillingConfigError) {
      sendBillingError(res, 500, "CONFIG_ERROR", err.message);
      return;
    }
    if (err instanceof PlayPurchaseOwnershipError) {
      sendBillingError(res, 403, "TOKEN_ALREADY_BOUND", err.message);
      return;
    }
    if (err instanceof PlayPurchaseVerificationError) {
      sendBillingError(res, 422, "VERIFICATION_FAILED", err.message, { refunded: err.refunded });
      return;
    }
    console.error("[billing] verify error:", err);
    sendBillingError(res, 500, "INTERNAL_ERROR", "Could not verify purchase.");
  }
});

billingRouter.post("/play/restore", authenticateUser, billingRestoreRateLimit, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    sendBillingError(res, 401, "UNAUTHORIZED", "Unauthorized");
    return;
  }

  const raw = (req.body as { purchases?: unknown })?.purchases;
  if (!Array.isArray(raw) || raw.length === 0) {
    sendBillingError(res, 400, "INVALID_REQUEST", "purchases array is required.");
    return;
  }

  const inputs: { productId: string; purchaseToken: string }[] = [];
  for (const item of raw as RestorePurchaseInput[]) {
    const productId = typeof item.productId === "string" ? item.productId.trim() : "";
    const purchaseToken = typeof item.purchaseToken === "string" ? item.purchaseToken.trim() : "";
    if (productId && purchaseToken && isKnownPlayProductId(productId)) {
      inputs.push({ productId, purchaseToken });
    }
  }

  if (inputs.length === 0) {
    res.json({ ok: true, tier: null, restored: false });
    return;
  }

  let bestTier: PlanTier | null = null;
  let bestRank = -1;
  const failures: string[] = [];

  for (const purchase of inputs) {
    try {
      const result = await verifyAndGrantPlayPurchase(userId, purchase.productId, purchase.purchaseToken);
      const tier = result.tier;
      const rank = TIER_RANK[tier];
      if (rank > bestRank) {
        bestRank = rank;
        bestTier = tier;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "verify failed";
      failures.push(`${purchase.productId}: ${msg}`);
    }
  }

  if (!bestTier) {
    sendBillingError(
      res,
      422,
      "RESTORE_FAILED",
      failures[0] ?? "No valid purchases could be restored.",
      { failures }
    );
    return;
  }

  res.json({ ok: true, tier: bestTier, restored: true, failures: failures.length > 0 ? failures : undefined });
});
