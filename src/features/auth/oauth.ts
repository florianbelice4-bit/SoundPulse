import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { supabase } from "@/src/lib/supabase";

WebBrowser.maybeCompleteAuthSession();

/**
 * Deep link for OAuth and email-confirmation callbacks. Must be a top-level
 * route (app/auth-callback.tsx): the (auth) group never appears in URLs, so
 * soundpulse://auth/sign-in has no matching route. Add this exact URL to
 * Supabase Auth URL Configuration Redirect URLs.
 */
export const AUTH_CALLBACK_URL = "soundpulse://auth-callback";

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
    ((lower.includes("auth-callback") || lower.includes("auth/sign-in")) && lower.includes("error="))
  );
}

/**
 * The PKCE auth code is single-use, and a callback can reach the app through
 * several paths at once (auth-callback route, the root-layout URL listener,
 * and the awaited openAuthSessionAsync result). Exchange each code once and
 * share the result with every caller.
 */
let lastCodeExchange: { code: string; result: Promise<{ error: Error | null }> } | null = null;

function exchangeCodeOnce(code: string): Promise<{ error: Error | null }> {
  if (lastCodeExchange?.code !== code) {
    lastCodeExchange = {
      code,
      result: supabase.auth
        .exchangeCodeForSession(code)
        .then(({ error }) => ({ error: error ?? null }))
        .catch((e: unknown) => ({ error: e instanceof Error ? e : new Error(String(e)) })),
    };
  }
  return lastCodeExchange.result;
}

export async function createSessionFromOAuthUrl(url: string): Promise<{ error: Error | null }> {
  try {
    const params = parseAuthCallbackParams(url);

    if (params.error_description || params.error) {
      return { error: new Error(params.error_description || params.error) };
    }

    if (params.code) {
      return exchangeCodeOnce(params.code);
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
        redirectTo: AUTH_CALLBACK_URL,
      },
    });
    return { error: error ?? null };
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: AUTH_CALLBACK_URL,
      skipBrowserRedirect: true,
    },
  });

  if (error) {
    return { error };
  }
  if (!data?.url) {
    return { error: new Error("OAuth URL missing") };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, AUTH_CALLBACK_URL);
  if (result.type === "cancel" || result.type === "dismiss") {
    return { error: null, cancelled: true };
  }
  if (result.type !== "success") {
    return { error: new Error("Google sign-in was not completed") };
  }

  return createSessionFromOAuthUrl(result.url);
}
