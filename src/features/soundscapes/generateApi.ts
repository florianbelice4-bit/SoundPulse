import { ensureBackendUrl, backendJsonHeaders } from "@/src/lib/backend";
import { sanitizedErrorReason, trackEvent } from "@/src/lib/analytics";
import { fetchWithTimeout, RequestTimeoutError } from "@/src/lib/fetchWithTimeout";
import { supabase } from "@/src/lib/supabase";

export type GenerateSoundscapeResult = {
  url: string;
  duration: number;
};

export class GenerateSoundscapeError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "GenerateSoundscapeError";
    this.status = status;
    this.code = code;
  }
}

const GENERATION_ERROR_MESSAGES: Record<string, string> = {
  GENERATION_LIMIT_REACHED:
    "You've used all your AI generations this month. Upgrade to generate more.",
  PAID_PLAN_REQUIRED: "AI generation requires a paid plan. Upgrade to start generating sounds.",
  RATE_LIMIT_EXCEEDED: "Too many generation requests. Please wait a minute and try again.",
  GENERATION_RESERVE_FAILED:
    "We could not record your generation usage. Please try again in a moment.",
  EMAIL_NOT_VERIFIED: "Verify your email before generating AI soundscapes.",
  CONTENT_MODERATION_BLOCKED: "This prompt isn't allowed. Please try a different description.",
  GENERATION_FAILED: "Sound generation failed. Please try again.",
  GENERATION_UNAVAILABLE: "Sound generation is temporarily unavailable. Please try again later.",
};

function messageForGenerationError(code: string): string {
  return GENERATION_ERROR_MESSAGES[code] ?? code;
}

export async function generateSoundscape(
  prompt: string,
  userId: string,
  durationSeconds = 15
): Promise<GenerateSoundscapeResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    throw new GenerateSoundscapeError("Sign in to generate sounds.", 401);
  }

  const baseUrl = ensureBackendUrl();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${baseUrl}/v1/sounds/generate`, {
      method: "POST",
      headers: backendJsonHeaders(token),
      body: JSON.stringify({
        prompt: prompt.trim(),
        userId,
        duration_seconds: durationSeconds,
      }),
      timeoutMs: 60000,
    });
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new GenerateSoundscapeError(error.message, 408, "TIMEOUT");
    }
    throw new GenerateSoundscapeError(
      "Couldn't reach the server. Check your connection and try again.",
      0,
      "NETWORK"
    );
  }

  const text = await res.text();
  let parsed: { url?: string; duration?: number; error?: string } = {};
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
          ? "RATE_LIMIT_EXCEEDED"
          : undefined;
    const message = code ? messageForGenerationError(code) : text || `Request failed (${res.status})`;
    void trackEvent("sound_generation_failed", {
      error_reason: sanitizedErrorReason(code ?? message),
      prompt_length: prompt.trim().length,
    });
    throw new GenerateSoundscapeError(message, res.status, code);
  }

  const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
  const duration = typeof parsed.duration === "number" ? parsed.duration : durationSeconds;
  if (!url) {
    throw new GenerateSoundscapeError("Server did not return an audio URL.", 502);
  }

  void trackEvent("sound_generated", { prompt_length: prompt.trim().length });
  return { url, duration };
}
