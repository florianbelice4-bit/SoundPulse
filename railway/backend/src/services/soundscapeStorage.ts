import { randomBytes } from "node:crypto";

import { supabaseAdmin } from "../lib/supabaseAdmin.js";

const BUCKET = "soundscapes";

export async function uploadGeneratedSoundscape(
  userId: string,
  audio: Buffer,
  durationSeconds: number
): Promise<{ url: string; duration: number; path: string }> {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${Date.now()}-${randomBytes(6).toString("hex")}.mp3`;
  const objectPath = `${safeUser}/${fileName}`;

  const { error: uploadError } = await supabaseAdmin.storage.from(BUCKET).upload(objectPath, audio, {
    contentType: "audio/mpeg",
    cacheControl: "3600",
    upsert: false,
  });

  if (uploadError) {
    throw new Error(`Supabase storage upload failed: ${uploadError.message}`);
  }

  const { data: publicData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(objectPath);
  let url = publicData.publicUrl;

  if (!url) {
    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(objectPath, 60 * 60 * 24 * 7);
    if (signError || !signed?.signedUrl) {
      throw new Error(signError?.message ?? "Could not create signed URL for soundscape");
    }
    url = signed.signedUrl;
  }

  return { url, duration: durationSeconds, path: objectPath };
}

/**
 * Best-effort deletion of every soundscape a user owns (their `<user_id>/`
 * folder). Used by account deletion. Never throws — account removal proceeds
 * even if storage cleanup partially fails (orphaned files are harmless).
 */
export async function deleteUserSoundscapes(userId: string): Promise<void> {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list(safeUser, { limit: 1000 });
  if (error) {
    console.error("[soundscapeStorage] list for delete failed:", error.message);
    return;
  }
  const paths = (data ?? []).map((file) => `${safeUser}/${file.name}`);
  if (paths.length === 0) {
    return;
  }
  const { error: removeError } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
  if (removeError) {
    console.error("[soundscapeStorage] remove for delete failed:", removeError.message);
  }
}
