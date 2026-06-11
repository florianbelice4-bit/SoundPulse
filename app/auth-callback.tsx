import { useURL } from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Screen } from "@/src/components/core/Screen";
import {
  AUTH_CALLBACK_URL,
  createSessionFromOAuthUrl,
  isOAuthCallbackUrl,
} from "@/src/features/auth/oauth";
import { useAppTheme } from "@/src/theme";

const HANDLE_TIMEOUT_MS = 5000;

/**
 * Landing route for soundpulse://auth-callback deep links (Google OAuth and
 * email confirmation). Lives at the top level because the (auth) route group
 * never appears in URLs. Session creation is shared with the root-layout URL
 * listener, so whichever handler runs first wins and the rest reuse its result.
 */
export default function AuthCallbackScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const incomingUrl = useURL();
  const params = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
  }>();
  const handledRef = useRef(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: theme.spacing.md,
        },
        text: {
          ...theme.typography.body,
          color: theme.colors.textSecondary,
        },
      }),
    [theme]
  );

  useEffect(() => {
    if (handledRef.current) {
      return;
    }

    // Prefer the raw URL: email confirmation links carry tokens in the
    // #fragment, which never reaches useLocalSearchParams.
    const callbackUrl =
      incomingUrl && isOAuthCallbackUrl(incomingUrl) ? incomingUrl : null;
    const code = typeof params.code === "string" ? params.code.trim() : "";
    const errorDescription =
      (typeof params.error_description === "string" && params.error_description) ||
      (typeof params.error === "string" && params.error) ||
      "";

    if (!callbackUrl && !code && !errorDescription) {
      return;
    }
    handledRef.current = true;

    void (async () => {
      if (!callbackUrl && errorDescription) {
        router.replace(`/(auth)/sign-in?error=${encodeURIComponent(errorDescription)}` as never);
        return;
      }

      const url = callbackUrl ?? `${AUTH_CALLBACK_URL}?code=${encodeURIComponent(code)}`;
      const { error } = await createSessionFromOAuthUrl(url);
      if (error) {
        router.replace(`/(auth)/sign-in?error=${encodeURIComponent(error.message)}` as never);
        return;
      }
      router.replace("/(tabs)/home");
    })();
  }, [incomingUrl, params.code, params.error, params.error_description, router]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!handledRef.current) {
        handledRef.current = true;
        router.replace("/(auth)/sign-in");
      }
    }, HANDLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <Screen>
      <View style={styles.container}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={styles.text}>Signing you in...</Text>
      </View>
    </Screen>
  );
}
