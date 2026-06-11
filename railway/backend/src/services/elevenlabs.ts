const ELEVENLABS_SOUND_GENERATION_URL = "https://api.elevenlabs.io/v1/sound-generation";
const ELEVENLABS_TIMEOUT_MS = 60000;

export class ElevenLabsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsConfigError";
  }
}

export class ElevenLabsGenerationError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ElevenLabsGenerationError";
    this.status = status;
  }
}

/**
 * Calls ElevenLabs Sound Generation API.
 * Set `ELEVENLABS_API_KEY` in Railway (or local `.env` for `railway/backend`).
 */
export async function generateSoundEffect(
  prompt: string,
  durationSeconds: number
): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new ElevenLabsConfigError(
      "ELEVENLABS_API_KEY is not configured. Add it in the Railway dashboard."
    );
  }

  const url = `${ELEVENLABS_SOUND_GENERATION_URL}?output_format=mp3_44100_128`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: prompt,
        duration_seconds: durationSeconds,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ElevenLabsGenerationError("ElevenLabs request timed out.", 504);
    }
    throw new ElevenLabsGenerationError(
      err instanceof Error ? err.message : "ElevenLabs request failed.",
      502
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ElevenLabsGenerationError(
      `ElevenLabs sound generation failed (${res.status}): ${detail.slice(0, 400)}`,
      res.status
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
