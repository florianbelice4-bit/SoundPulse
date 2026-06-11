import { reportCommunitySoundViaBackend } from "@/src/features/community/communityBackendApi";
import { supabase } from "@/src/lib/supabase";

type CommunitySoundOwnerRow = {
  user_id: string;
};

type BlockedUserRow = {
  blocked_id: string;
};

type BlockedUserProfileRow = {
  blocked_id: string;
  display_name: string | null;
};

export type BlockedUserProfile = {
  id: string;
  displayName: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getCurrentUserId(): Promise<string> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    throw new Error(error.message);
  }
  if (!user?.id) {
    throw new Error("Sign in to use safety tools.");
  }
  return user.id;
}

export function formatUserDisplay(userId: string, displayName?: string | null): string {
  const normalizedName = displayName?.trim();
  if (normalizedName && !UUID_PATTERN.test(normalizedName)) {
    return normalizedName;
  }

  const compactId = userId.replace(/-/g, "");
  const suffix = (compactId || userId).slice(-6);
  return `Creator ${suffix || "unknown"}`;
}

async function getReportedUserId(soundId: string, reporterId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("community_sounds")
    .select("user_id")
    .eq("id", soundId)
    .maybeSingle<CommunitySoundOwnerRow>();

  if (error) {
    throw new Error(error.message);
  }
  if (!data?.user_id) {
    throw new Error("This sound is no longer available.");
  }
  if (data.user_id === reporterId) {
    throw new Error("You cannot report your own sound.");
  }
  return data.user_id;
}

export async function reportSound(soundId: string, reason: string, details?: string): Promise<void> {
  const trimmedSoundId = soundId.trim();
  const trimmedReason = reason.trim();
  const trimmedDetails = details?.trim() || "";

  if (!trimmedSoundId) {
    throw new Error("Choose a sound to report.");
  }
  if (!trimmedReason) {
    throw new Error("Choose a report reason.");
  }

  // Validate the target client-side (existence + not-your-own-sound) for a
  // friendly message, then route the report through the backend so it lands in
  // sound_reports — the table whose trigger powers trusted-reporter auto-hide.
  const reporterId = await getCurrentUserId();
  await getReportedUserId(trimmedSoundId, reporterId);

  const combinedReason = trimmedDetails ? `${trimmedReason} - ${trimmedDetails}` : trimmedReason;
  await reportCommunitySoundViaBackend(trimmedSoundId, combinedReason);
}

export async function blockUser(userId: string): Promise<void> {
  const blockedId = userId.trim();
  if (!blockedId) {
    throw new Error("Choose a user to block.");
  }

  const blockerId = await getCurrentUserId();
  if (blockerId === blockedId) {
    throw new Error("You cannot block yourself.");
  }

  const { error } = await supabase.from("blocked_users").insert({
    blocker_id: blockerId,
    blocked_id: blockedId,
  });

  if (error && error.code !== "23505") {
    throw new Error(error.message);
  }
}

export async function unblockUser(userId: string): Promise<void> {
  const blockedId = userId.trim();
  if (!blockedId) {
    throw new Error("Choose a user to unblock.");
  }

  const blockerId = await getCurrentUserId();
  const { error } = await supabase
    .from("blocked_users")
    .delete()
    .eq("blocker_id", blockerId)
    .eq("blocked_id", blockedId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function getBlockedUsers(): Promise<string[]> {
  const blockerId = await getCurrentUserId().catch(() => null);
  if (!blockerId) {
    return [];
  }

  const { data, error } = await supabase
    .from("blocked_users")
    .select("blocked_id")
    .eq("blocker_id", blockerId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as BlockedUserRow[])
    .map((row) => row.blocked_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function getBlockedUserProfiles(): Promise<BlockedUserProfile[]> {
  const { data, error } = await supabase.rpc("get_blocked_users_with_profiles");

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as BlockedUserProfileRow[]).map((row) => ({
    id: row.blocked_id,
    displayName: formatUserDisplay(row.blocked_id, row.display_name),
  }));
}
