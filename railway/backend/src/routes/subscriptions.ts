import express, { type Request, type Response } from "express";

import { authenticateUser } from "../middleware/authenticateUser.js";
import { billingVerifyRateLimit } from "../middleware/userRateLimit.js";
import {
  PlayBillingConfigError,
  PlayPurchaseOwnershipError,
  PlayPurchaseVerificationError,
  verifyAndGrantPlayPurchase,
} from "../services/playBilling.js";
import { isKnownPlayProductId } from "../services/playProducts.js";

export const subscriptionsRouter = express.Router();

type VerifyBody = {
  userId?: unknown;
  productId?: unknown;
  purchaseToken?: unknown;
  packageName?: unknown;
};

function sendSubscriptionError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  res.status(status).json({ ok: false, error: code, message, ...extra });
}

subscriptionsRouter.post(
  "/verify",
  authenticateUser,
  billingVerifyRateLimit,
  async (req: Request, res: Response) => {
    const authUserId = req.user?.id;
    if (!authUserId) {
      sendSubscriptionError(res, 401, "UNAUTHORIZED", "Unauthorized");
      return;
    }

    const body = (req.body ?? {}) as VerifyBody;
    const bodyUserId = typeof body.userId === "string" ? body.userId.trim() : "";
    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    const purchaseToken = typeof body.purchaseToken === "string" ? body.purchaseToken.trim() : "";
    const packageName = typeof body.packageName === "string" ? body.packageName.trim() : "";

    if (bodyUserId && bodyUserId !== authUserId) {
      sendSubscriptionError(res, 403, "USER_MISMATCH", "Purchase user does not match the signed-in user.");
      return;
    }
    if (!productId || !purchaseToken) {
      sendSubscriptionError(res, 400, "INVALID_REQUEST", "productId and purchaseToken are required.");
      return;
    }
    if (!isKnownPlayProductId(productId)) {
      sendSubscriptionError(res, 400, "UNKNOWN_PRODUCT", `Unknown product ID: ${productId}`);
      return;
    }

    try {
      const result = await verifyAndGrantPlayPurchase(
        authUserId,
        productId,
        purchaseToken,
        packageName || undefined
      );
      res.json({
        ok: true,
        tier: result.tier,
        plan: result.tier,
        productId,
        status: result.status,
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      if (err instanceof PlayBillingConfigError) {
        sendSubscriptionError(res, 500, "CONFIG_ERROR", err.message);
        return;
      }
      if (err instanceof PlayPurchaseOwnershipError) {
        sendSubscriptionError(res, 403, "TOKEN_ALREADY_BOUND", err.message);
        return;
      }
      if (err instanceof PlayPurchaseVerificationError) {
        sendSubscriptionError(res, 422, "VERIFICATION_FAILED", err.message, {
          refunded: err.refunded,
        });
        return;
      }
      console.error("[subscriptions/verify]", err);
      sendSubscriptionError(res, 500, "INTERNAL_ERROR", "Could not verify purchase.");
    }
  }
);
