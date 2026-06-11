import { ensureBackendUrl, backendJsonHeaders } from "@/src/lib/backend";
import { fetchWithTimeout, RequestTimeoutError } from "@/src/lib/fetchWithTimeout";
import { supabase } from "@/src/lib/supabase";

import { AUTH_CALLBACK_URL } from "./oauth";

export async function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

/** Redirect URL for Supabase email confirmation (add to Auth URL Configuration in dashboard). */
export function getAuthEmailRedirectUrl(): string {
  return AUTH_CALLBACK_URL;
}

export type SignUpResult = {
  ok: boolean;
  userId: string | null;
  needsEmailVerification: boolean;
  error?: string;
  errorCode?: string;
};

export async function signUpWithEmail(email: string, password: string): Promise<SignUpResult> {
  const baseUrl = ensureBackendUrl();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${baseUrl}/v1/auth/signup`, {
      method: "POST",
      headers: backendJsonHeaders(),
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        password,
        website: "",
      }),
      timeoutMs: 15000,
    });
  } catch (error) {
    return {
      ok: false,
      userId: null,
      needsEmailVerification: false,
      error:
        error instanceof RequestTimeoutError
          ? error.message
          : "Couldn't reach the server. Check your connection and try again.",
    };
  }

  const text = await res.text();
  let parsed: {
    ok?: boolean;
    userId?: string | null;
    needsEmailVerification?: boolean;
    error?: string;
    message?: string;
  } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* non-json */
  }

  if (!res.ok) {
    return {
      ok: false,
      userId: null,
      needsEmailVerification: false,
      error: parsed.message ?? parsed.error ?? `Sign-up failed (${res.status})`,
      errorCode: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  }

  return {
    ok: true,
    userId: parsed.userId ?? null,
    needsEmailVerification: parsed.needsEmailVerification ?? true,
  };
}

export async function resendSignupConfirmationEmail(email: string) {
  return supabase.auth.resend({
    type: "signup",
    email: email.trim(),
    options: {
      emailRedirectTo: getAuthEmailRedirectUrl(),
    },
  });
}

export async function signOut() {
  return supabase.auth.signOut({ scope: "global" });
}

export async function sendPasswordResetEmail(email: string) {
  return supabase.auth.resetPasswordForEmail(email.trim());
}
