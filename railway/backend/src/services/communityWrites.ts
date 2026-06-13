import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import {
  isHttpsUrl,
  parseMixLayers,
  sanitizeCommunityTags,
  sanitizePlainText,
  sanitizeReportReason,
  sanitizeSoundTitle,
} from "./communityValidation.js";
import { userCanSubmitReport, userHasPremium } from "./premiumAccess.js";
import { containsProfanity, moderatePrompt } from "./promptModeration.js";

/** Public URL prefix for the user's own generated soundscapes. */
function ownedSoundscapePrefix(): string {
  const base = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/soundscapes/`;
}

/**
 * Reject anything that isn't an audio file the user generated: it must live in
 * this project's `soundscapes` bucket AND have a matching generated_sounds row
 * owned by the user. Blocks sharing external/copyrighted/arbitrary URLs.
 */
async function assertOwnedSoundscape(userId: string, audioUrl: string): Promise<void> {
  if (!audioUrl.startsWith(ownedSoundscapePrefix())) {
    throw new CommunityWriteError(
      "INVALID_AUDIO_URL",
      "You can only share sounds you generated in SoundPulse.",
      400
    );
  }

  const { data, error } = await supabaseAdmin
    .from("generated_sounds")
    .select("id")
    .eq("user_id", userId)
    .eq("url", audioUrl)
    .maybeSingle();

  if (error) {
    throw new CommunityWriteError("COMMUNITY_LOOKUP_FAILED", "Could not verify sound ownership.", 500);
  }
  if (!data) {
    throw new CommunityWriteError(
      "INVALID_AUDIO_URL",
      "You can only share sounds you generated in SoundPulse.",
      400
    );
  }
}

/** Block clearly-prohibited text before it reaches Discover. */
function assertTextAllowed(...parts: string[]): void {
  const combined = parts.filter(Boolean).join(" ");
  const result = moderatePrompt(combined);
  if (!result.allowed) {
    throw new CommunityWriteError(
      "CONTENT_MODERATION_BLOCKED",
      "This content isn't allowed. Please edit and try again.",
      400
    );
  }
  if (containsProfanity(combined)) {
    throw new CommunityWriteError(
      "PROFANITY_BLOCKED",
      "Please choose appropriate language.",
      400
    );
  }
}

export class CommunityWriteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CommunityWriteError";
    this.code = code;
    this.status = status;
  }
}

async function getVisibleCommunitySound(soundId: string) {
  const { data, error } = await supabaseAdmin
    .from("community_sounds")
    .select("id")
    .eq("id", soundId)
    .eq("is_public", true)
    .eq("is_hidden", false)
    .maybeSingle();

  if (error) {
    throw new CommunityWriteError("COMMUNITY_LOOKUP_FAILED", "Could not verify sound.", 500);
  }
  if (!data) {
    throw new CommunityWriteError("SOUND_NOT_FOUND", "Sound is not available.", 404);
  }
}

export async function toggleCommunityPulse(userId: string, soundId: string): Promise<boolean> {
  const trimmedId = soundId.trim();
  if (!trimmedId) {
    throw new CommunityWriteError("INVALID_REQUEST", "soundId is required.");
  }

  await getVisibleCommunitySound(trimmedId);

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("sound_likes")
    .select("id")
    .eq("sound_id", trimmedId)
    .eq("user_id", userId)
    .maybeSingle();

  if (lookupError) {
    throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", "Could not update pulse.", 500);
  }

  if (existing) {
    const { error } = await supabaseAdmin
      .from("sound_likes")
      .delete()
      .eq("sound_id", trimmedId)
      .eq("user_id", userId);
    if (error) {
      throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", error.message, 500);
    }
    return false;
  }

  const premium = await userHasPremium(userId);
  if (!premium) {
    throw new CommunityWriteError("PREMIUM_REQUIRED", "Premium is required to pulse community sounds.", 403);
  }

  const { error } = await supabaseAdmin.from("sound_likes").insert({
    sound_id: trimmedId,
    user_id: userId,
  });
  if (error) {
    throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", error.message, 500);
  }
  return true;
}

export async function toggleCommunitySave(userId: string, soundId: string): Promise<boolean> {
  const trimmedId = soundId.trim();
  if (!trimmedId) {
    throw new CommunityWriteError("INVALID_REQUEST", "soundId is required.");
  }

  await getVisibleCommunitySound(trimmedId);

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("sound_saves")
    .select("id")
    .eq("sound_id", trimmedId)
    .eq("user_id", userId)
    .maybeSingle();

  if (lookupError) {
    throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", "Could not update save.", 500);
  }

  if (existing) {
    const { error } = await supabaseAdmin
      .from("sound_saves")
      .delete()
      .eq("sound_id", trimmedId)
      .eq("user_id", userId);
    if (error) {
      throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", error.message, 500);
    }
    return false;
  }

  const premium = await userHasPremium(userId);
  if (!premium) {
    throw new CommunityWriteError("PREMIUM_REQUIRED", "Premium is required to save community sounds.", 403);
  }

  const { error } = await supabaseAdmin.from("sound_saves").insert({
    sound_id: trimmedId,
    user_id: userId,
  });
  if (error) {
    throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", error.message, 500);
  }
  return true;
}

export async function reportCommunitySound(
  userId: string,
  emailConfirmed: boolean,
  soundId: string,
  reason: string
): Promise<void> {
  const trimmedId = soundId.trim();
  if (!trimmedId) {
    throw new CommunityWriteError("INVALID_REQUEST", "soundId is required.");
  }

  const canReport = await userCanSubmitReport(userId, emailConfirmed);
  if (!canReport) {
    throw new CommunityWriteError(
      "REPORT_NOT_ALLOWED",
      "Verified email and a 24-hour-old account are required to report content.",
      403
    );
  }

  await getVisibleCommunitySound(trimmedId);

  const { error } = await supabaseAdmin.from("sound_reports").insert({
    sound_id: trimmedId,
    user_id: userId,
    reason: sanitizeReportReason(reason) || "Community report",
    status: "pending",
  });

  if (error) {
    if (error.code === "23505") {
      throw new CommunityWriteError("REPORT_ALREADY_SUBMITTED", "You already reported this sound.", 409);
    }
    throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", error.message, 500);
  }
}

type ShareAudioInput = {
  kind: "audio";
  title: string;
  prompt: string;
  audioUrl: string;
  duration: number;
  tags: unknown;
};

type ShareMixInput = {
  kind: "mix";
  name: string;
  layers: unknown;
  savedMixId: string;
  tags?: unknown;
};

export async function shareToCommunity(
  userId: string,
  input: ShareAudioInput | ShareMixInput
): Promise<void> {
  const premium = await userHasPremium(userId);
  if (!premium) {
    throw new CommunityWriteError("PREMIUM_REQUIRED", "Premium is required to share to Discover.", 403);
  }

  if (input.kind === "audio") {
    const title = sanitizeSoundTitle(input.title);
    const prompt = sanitizePlainText(input.prompt, 500);
    const audioUrl = typeof input.audioUrl === "string" ? input.audioUrl.trim() : "";
    const duration = Math.max(0, Math.min(3600, Math.round(input.duration)));

    if (!title || !prompt || !audioUrl || !isHttpsUrl(audioUrl)) {
      throw new CommunityWriteError("INVALID_REQUEST", "title, prompt, and a valid audioUrl are required.");
    }

    assertTextAllowed(title, prompt);
    await assertOwnedSoundscape(userId, audioUrl);

    const { error } = await supabaseAdmin.from("community_sounds").insert({
      user_id: userId,
      title,
      prompt,
      audio_url: audioUrl,
      duration,
      tags: sanitizeCommunityTags(input.tags),
      is_public: true,
      kind: "audio",
    });

    if (error) {
      throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", error.message, 500);
    }
    return;
  }

  const mixName = sanitizeSoundTitle(input.name);
  const savedMixId = typeof input.savedMixId === "string" ? input.savedMixId.trim() : "";
  const layers = parseMixLayers(input.layers);

  if (!mixName || !savedMixId || !layers) {
    throw new CommunityWriteError("INVALID_REQUEST", "name, savedMixId, and valid layers are required.");
  }

  assertTextAllowed(mixName);

  const { error } = await supabaseAdmin.from("community_sounds").insert({
    user_id: userId,
    title: mixName,
    prompt: `Layer mix · ${mixName}`,
    kind: "mix",
    mix_layers: layers,
    saved_mix_id: savedMixId,
    tags: sanitizeCommunityTags(input.tags),
    is_public: true,
    duration: 0,
  });

  if (error) {
    throw new CommunityWriteError("COMMUNITY_WRITE_FAILED", error.message, 500);
  }
}
