import { ensureBackendUrl, backendJsonHeaders } from "@/src/lib/backend";
import { fetchWithTimeout, RequestTimeoutError } from "@/src/lib/fetchWithTimeout";
import { supabase } from "@/src/lib/supabase";

export class CommunityBackendError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "CommunityBackendError";
    this.status = status;
    this.code = code;
  }
}

const COMMUNITY_ERROR_MESSAGES: Record<string, string> = {
  PREMIUM_REQUIRED: "Premium is required for this community action.",
  REPORT_NOT_ALLOWED: "Verify your email and wait 24 hours after sign-up to report content.",
  REPORT_ALREADY_SUBMITTED: "You already reported this sound.",
  SOUND_NOT_FOUND: "This sound is no longer available.",
  COMMUNITY_PULSE_RATE_LIMITED: "Too many pulse actions. Try again later.",
  COMMUNITY_SAVE_RATE_LIMITED: "Too many save actions. Try again later.",
  COMMUNITY_REPORT_RATE_LIMITED: "Too many reports. Try again later.",
  COMMUNITY_SHARE_RATE_LIMITED: "Too many share actions. Try again later.",
};

function messageForCommunityError(code: string, fallback: string): string {
  return COMMUNITY_ERROR_MESSAGES[code] ?? fallback;
}

async function getAccessToken(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    throw new CommunityBackendError("Sign in to use community features.", 401);
  }
  return token;
}

async function postCommunity<T>(path: string, body: unknown): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = ensureBackendUrl();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${baseUrl}/v1/community/${path}`, {
      method: "POST",
      headers: backendJsonHeaders(token),
      body: JSON.stringify(body),
      timeoutMs: 30000,
    });
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new CommunityBackendError(error.message, 408, "TIMEOUT");
    }
    throw new CommunityBackendError(
      "Couldn't reach the server. Check your connection and try again.",
      0,
      "NETWORK"
    );
  }

  const text = await res.text();
  let parsed: { error?: string; message?: string; pulsed?: boolean; saved?: boolean } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* non-json */
  }

  if (!res.ok) {
    const code =
      typeof parsed.error === "string"
        ? parsed.error
        : res.status === 429
          ? `${path.toUpperCase()}_RATE_LIMITED`
          : undefined;
    const fallback = typeof parsed.message === "string" ? parsed.message : text || `Request failed (${res.status})`;
    const message = code ? messageForCommunityError(code, fallback) : fallback;
    throw new CommunityBackendError(message, res.status, code);
  }

  return parsed as T;
}

export async function pulseCommunitySoundViaBackend(soundId: string): Promise<boolean> {
  const result = await postCommunity<{ pulsed?: boolean }>("pulse", { soundId });
  return result.pulsed === true;
}

export async function saveCommunitySoundViaBackend(soundId: string): Promise<boolean> {
  const result = await postCommunity<{ saved?: boolean }>("save", { soundId });
  return result.saved === true;
}

export async function reportCommunitySoundViaBackend(soundId: string, reason: string): Promise<void> {
  await postCommunity("report", { soundId, reason });
}

export async function shareAudioToCommunityViaBackend(input: {
  title: string;
  prompt: string;
  audioUrl: string;
  duration: number;
  tags: string[];
}): Promise<void> {
  await postCommunity("share", {
    kind: "audio",
    title: input.title,
    prompt: input.prompt,
    audioUrl: input.audioUrl,
    duration: input.duration,
    tags: input.tags,
  });
}

export async function shareMixToCommunityViaBackend(input: {
  name: string;
  layers: unknown;
  savedMixId: string;
  tags?: string[];
}): Promise<void> {
  await postCommunity("share", {
    kind: "mix",
    name: input.name,
    layers: input.layers,
    savedMixId: input.savedMixId,
    tags: input.tags,
  });
}
