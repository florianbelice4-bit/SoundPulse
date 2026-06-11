import { containsProfanity } from "@/src/lib/profanity";
import { sanitizeDisplayName } from "@/src/lib/sanitize";
import { supabase } from "@/src/lib/supabase";

const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 32;

export function normalizeDisplayName(value: string): string {
  return sanitizeDisplayName(value);
}

export function validateDisplayName(value: string): string | null {
  const normalized = normalizeDisplayName(value);
  if (normalized.length < DISPLAY_NAME_MIN) {
    return `Name must be at least ${DISPLAY_NAME_MIN} characters.`;
  }
  if (normalized.length > DISPLAY_NAME_MAX) {
    return `Name must be ${DISPLAY_NAME_MAX} characters or fewer.`;
  }
  if (normalized !== value.trim().replace(/\s+/g, " ")) {
    return "Name contains invalid characters.";
  }
  if (containsProfanity(normalized)) {
    return "Please choose appropriate language.";
  }
  return null;
}

export async function isDisplayNameTaken(name: string, userId: string): Promise<boolean> {
  const normalized = normalizeDisplayName(name);
  const { data, error } = await supabase
    .from("profiles_public")
    .select("id")
    .ilike("display_name", normalized)
    .neq("id", userId)
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).length > 0;
}

export async function updateProfileDisplayName(userId: string, name: string): Promise<void> {
  const normalized = normalizeDisplayName(name);
  const validationError = validateDisplayName(normalized);
  if (validationError) {
    throw new Error(validationError);
  }

  if (await isDisplayNameTaken(normalized, userId)) {
    throw new Error("That display name is already taken.");
  }

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: normalized })
    .eq("id", userId);

  if (error) {
    if (error.code === "23505") {
      throw new Error("That display name is already taken.");
    }
    throw new Error(error.message);
  }
}
