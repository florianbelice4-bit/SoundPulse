/** Thrown when a request exceeds its timeout (distinct from a user/network abort). */
export class RequestTimeoutError extends Error {
  constructor(message = "Request timed out. Please check your connection and try again.") {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

export type FetchWithTimeoutOptions = RequestInit & { timeoutMs?: number };

/**
 * fetch() that aborts after `timeoutMs` (default 30s) so a dead/slow connection
 * can't hang a request forever. A timeout surfaces as RequestTimeoutError;
 * other network failures propagate unchanged.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = 30000, signal, ...rest } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Respect a caller-supplied signal alongside the timeout.
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new RequestTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
