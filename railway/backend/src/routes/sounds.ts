import * as Sentry from "@sentry/node";
import express, { type Request, type Response } from "express";

import { authenticateUser } from "../middleware/authenticateUser.js";
import { generateRateLimit } from "../middleware/generateRateLimit.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import {
  ElevenLabsConfigError,
  ElevenLabsGenerationError,
  generateSoundEffect,
} from "../services/elevenlabs.js";
import {
  assertGenerationSlotRecorded,
  GenerationLimitError,
  releaseGenerationSlot,
  reserveGenerationSlot,
} from "../services/generationLimits.js";
import { moderatePrompt } from "../services/promptModeration.js";
import { uploadGeneratedSoundscape } from "../services/soundscapeStorage.js";

export const soundsRouter = express.Router();

const DEFAULT_DURATION_SEC = 15;
const MIN_DURATION_SEC = 0.5;
const MAX_DURATION_SEC = 30;
const MAX_PROMPT_LEN = 500;
const GENERIC_GENERATION_ERROR = "Sound generation failed. Please try again.";

function clampDuration(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) {
    return DEFAULT_DURATION_SEC;
  }
  return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, n));
}

soundsRouter.post(
  "/generate",
  authenticateUser,
  requireVerifiedEmail,
  generateRateLimit,
  async (req: Request, res: Response) => {
  const authUserId = req.user?.id;
  if (!authUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let slotReserved = false;

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const bodyUserId = typeof body.userId === "string" ? body.userId.trim() : "";

    if (bodyUserId && bodyUserId !== authUserId) {
      return res.status(403).json({ error: "userId does not match authenticated user" });
    }

    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }
    if (prompt.length > MAX_PROMPT_LEN) {
      return res.status(400).json({ error: `prompt must be at most ${MAX_PROMPT_LEN} characters` });
    }

    const moderation = moderatePrompt(prompt);
    if (!moderation.allowed) {
      // Log the category for abuse monitoring; never log the prompt itself (PII).
      Sentry.captureMessage("prompt_moderation_blocked", {
        level: "warning",
        tags: { feature: "generation", moderation_category: moderation.category },
      });
      return res.status(400).json({
        error: "CONTENT_MODERATION_BLOCKED",
        message: "This prompt isn't allowed. Please try a different description.",
      });
    }

    const durationSeconds = clampDuration(body.duration_seconds);

    await reserveGenerationSlot(authUserId);
    slotReserved = true;

    const audioBuffer = await generateSoundEffect(prompt, durationSeconds);
    const stored = await uploadGeneratedSoundscape(authUserId, audioBuffer, durationSeconds);

    try {
      await assertGenerationSlotRecorded(authUserId);
    } catch (verifyErr) {
      console.error("[sounds/generate] usage accounting verify failed after success:", verifyErr);
      throw verifyErr;
    }

    return res.json({
      url: stored.url,
      duration: stored.duration,
    });
  } catch (err) {
    if (slotReserved) {
      await releaseGenerationSlot(authUserId);
    }

    if (err instanceof GenerationLimitError) {
      const status = err.code === "GENERATION_RESERVE_FAILED" ? 500 : 403;
      return res.status(status).json({ error: err.code });
    }
    if (err instanceof ElevenLabsConfigError) {
      // Misconfiguration is ours, not the user's — log detail, return generic.
      console.error("[sounds/generate] config:", err.message);
      Sentry.captureException(err, { tags: { feature: "generation" } });
      return res.status(503).json({ error: "GENERATION_UNAVAILABLE", message: GENERIC_GENERATION_ERROR });
    }
    if (err instanceof ElevenLabsGenerationError) {
      // Upstream detail can leak quota/API hints — log it, send a clean message.
      console.error("[sounds/generate] upstream:", err.status, err.message);
      Sentry.captureException(err, { tags: { feature: "generation", upstream_status: String(err.status) } });
      if (err.status === 429) {
        return res.status(429).json({ error: "RATE_LIMIT_EXCEEDED", message: GENERIC_GENERATION_ERROR });
      }
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      return res.status(status).json({ error: "GENERATION_FAILED", message: GENERIC_GENERATION_ERROR });
    }
    console.error("[sounds/generate]", err);
    Sentry.captureException(err, { tags: { feature: "generation" } });
    return res.status(500).json({ error: "GENERATION_FAILED", message: GENERIC_GENERATION_ERROR });
  }
});
