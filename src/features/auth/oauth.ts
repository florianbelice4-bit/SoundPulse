import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { supabase } from "@/src/lib/supabase";

WebBrowser.maybeCompleteAuthSession();

/** Add to Supabase Auth URL Configuration Redirect URLs. */
export const GOOGLE_OAUTH_REDIRECT_TO = "soundpulse://auth/sign-in";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Supabase callbacks carry params in the query (?code=, PKCE) or in the
 * fragment (#access_token=, implicit-style email confirmation links), so
 * collect key/value pairs from both.
 */
function parseAuthCallbackParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const collect = (segment: string) => {
    for (const pair of segment.split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      params[safeDecode(pair.slice(0, eq))] = safeDecode(pair.slice(eq + 1));
    }
  };

  const hashIdx = url.indexOf("#");
  const beforeFragment = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const queryIdx = beforeFragment.indexOf("?");
  if (queryIdx >= 0) {
    collect(beforeFragment.slice(queryIdx + 1));
  }
  if (hashIdx >= 0) {
    collect(url.slice(hashIdx + 1));
  }
  return params;
}

export function isOAuthCallbackUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  const lower = url.toLowerCase();
  if (!lower.startsWith("soundpulse://")) {
    return false;
  }
  return (
    lower.includes("access_token=") ||
    lower.includes("refresh_token=") ||
    lower.includes("code=") ||
    (lower.includes("auth/sign-in") && lower.includes("error="))
  );
}

export async function createSessionFromOAuthUrl(url: string): Promise<{ error: Error | null }> {
  try {
    const params = parseAuthCallbackParams(url);

    if (params.error_description || params.error) {
      return { error: new Error(params.error_description || params.error) };
    }

    if (params.code) {
      const { error } = await supabase.auth.exchangeCodeForSession(params.code);
      return { error: error ?? null };
    }

    if (params.access_token && params.refresh_token) {
      const { error } = await supabase.auth.setSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token,
      });
      return { error: error ?? null };
    }

    return { error: new Error("No auth tokens in callback URL") };
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export async function signInWithGoogle(): Promise<{ error: Error | null; cancelled?: boolean }> {
  if (Platform.OS === "web") {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: GOOGLE_OAUTH_REDIRECT_TO,
      },
    });
    return { error: error ?? null };
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: GOOGLE_OAUTH_REDIRECT_TO,
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    return { error };
  }
  if (!data?.url) {
    return { error: new Error("OAuth URL missing") };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, GOOGLE_OAUTH_REDIRECT_TO);
  if (result.type === "cancel" || result.type === "dismiss") {
    return { error: null, cancelled: true };
  }
  if (result.type !== "success") {
    return { error: new Error("Google sign-in was not completed") };
  }

  return createSessionFromOAuthUrl(result.url);
}
