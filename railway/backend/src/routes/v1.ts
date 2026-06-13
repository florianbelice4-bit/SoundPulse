import express, { type Request, type Response } from "express";

import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { authenticateUser } from "../middleware/authenticateUser.js";
import { accountDeleteRateLimit, accountExportRateLimit } from "../middleware/userRateLimit.js";
import { deleteUserSoundscapes } from "../services/soundscapeStorage.js";
import { authRouter } from "./auth.js";
import { billingRouter } from "./billing.js";
import { communityRouter } from "./community.js";
import { soundsRouter } from "./sounds.js";
import { subscriptionsRouter } from "./subscriptions.js";

export const v1Router = express.Router();

v1Router.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "soundpulse-backend",
    timestamp: new Date().toISOString(),
  });
});

v1Router.use("/auth", authRouter);
v1Router.use("/billing", billingRouter);
v1Router.use("/community", communityRouter);
v1Router.use("/sounds", soundsRouter);
v1Router.use("/subscriptions", subscriptionsRouter);

v1Router.delete("/account", authenticateUser, accountDeleteRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Remove storage files first (best-effort), then delete the auth user.
    // FK cascades clear the user's database rows.
    await deleteUserSoundscapes(userId);

    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (error) {
      console.error("[DELETE ACCOUNT] Error:", error);
      return res.status(500).json({ error: "Failed to delete account" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("[DELETE ACCOUNT] Error:", error);
    return res.status(500).json({ error: "Failed to delete account" });
  }
});

v1Router.get("/account/export", authenticateUser, accountExportRateLimit, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const [profile, sounds, saves, likes, subscriptions, reports] = await Promise.all([
      supabaseAdmin.from("profiles").select("*").eq("id", userId).maybeSingle(),
      supabaseAdmin.from("generated_sounds").select("*").eq("user_id", userId),
      supabaseAdmin.from("sound_saves").select("*").eq("user_id", userId),
      supabaseAdmin.from("sound_likes").select("*").eq("user_id", userId),
      // Exclude purchase_token / package_name from the export.
      supabaseAdmin
        .from("subscriptions")
        .select("id, plan, status, expires_at, product_id, auto_renewing, created_at, updated_at")
        .eq("user_id", userId),
      supabaseAdmin.from("sound_reports").select("*").eq("user_id", userId),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      user_id: userId,
      profile: profile.data ?? null,
      generated_sounds: sounds.data ?? [],
      saved_sounds: saves.data ?? [],
      pulses: likes.data ?? [],
      subscriptions: subscriptions.data ?? [],
      reports_submitted: reports.data ?? [],
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="soundpulse-data-export.json"');
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[account/export]", error);
    return res.status(500).json({ error: "EXPORT_FAILED", message: "Could not export your data." });
  }
});
