import "react-native-reanimated";

import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import * as Sentry from "@sentry/react-native";
import * as Linking from "expo-linking";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { seedNewUserProfile } from "@/src/features/auth/signupProfile";
import { needsEmailVerification } from "@/src/features/auth/emailVerification";
import { useAuthSession } from "@/src/features/auth/useAuthSession";
import { createSessionFromOAuthUrl, isOAuthCallbackUrl } from "@/src/features/auth/oauth";
import { soundpulseLinking } from "@/src/lib/appLinking";
import { initAnalytics, trackEvent } from "@/src/lib/analytics";
import { ThemePreferenceProvider, useThemePreference } from "@/src/theme";

/** Deep link map: soundpulse://auth-callback routes to app/auth-callback.tsx. */
export const linking = soundpulseLinking;

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

if (typeof sentryDsn === "string" && sentryDsn.length > 0) {
  Sentry.init({
    dsn: sentryDsn,
    enabled: !__DEV__,
    sendDefaultPii: false,
  });
}

function useProtectedNavigation() {
  const router = useRouter();
  const segments = useSegments();
  const { session, isLoading } = useAuthSession();
  const { theme, mode } = useThemePreference();

  const navigationTheme = useMemo(() => {
    const base = mode === "light" ? DefaultTheme : DarkTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: theme.colors.background,
        card: theme.colors.surface,
        border: theme.colors.border,
        primary: theme.colors.primary,
        text: theme.colors.textPrimary,
      },
    };
  }, [mode, theme]);

  const shouldRedirectEmptyDeepLink = useCallback((url?: string | null) => {
    if (!url) {
      return false;
    }
    if (url === "soundpulse://" || url === "soundpulse:///") {
      return true;
    }
    try {
      const parsed = Linking.parse(url);
      const path = typeof parsed.path === "string" ? parsed.path.trim() : "";
      return (parsed.scheme ?? "").toLowerCase() === "soundpulse" && path.length === 0;
    } catch {
      return false;
    }
  }, []);

  const handleOAuthCallback = useCallback(async (url: string | null | undefined) => {
    if (!url || !isOAuthCallbackUrl(url)) {
      return false;
    }
    const { error } = await createSessionFromOAuthUrl(url);
    if (error) {
      console.warn("[auth] OAuth callback failed:", error.message);
    }
    return true;
  }, []);

  useEffect(() => {
    const handleURL = ({ url }: { url: string }) => {
      void (async () => {
        if (await handleOAuthCallback(url)) {
          return;
        }
        if (shouldRedirectEmptyDeepLink(url)) {
          router.replace("/(tabs)/home");
        }
      })();
    };
    const sub = Linking.addEventListener("url", handleURL);
    return () => sub.remove();
  }, [handleOAuthCallback, router, shouldRedirectEmptyDeepLink]);

  useEffect(() => {
    void Linking.getInitialURL().then(async (url) => {
      if (await handleOAuthCallback(url)) {
        return;
      }
      if (shouldRedirectEmptyDeepLink(url)) {
        router.replace("/(tabs)/home");
      }
    });
  }, [handleOAuthCallback, router, shouldRedirectEmptyDeepLink]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const inAuthGroup = segments[0] === "(auth)";
    const isPublicLegal =
      segments[0] === "privacy-policy" || segments[0] === "terms-of-service";
    // The OAuth/email callback screen creates the session itself — don't
    // bounce signed-out users off it while the code exchange is in flight.
    const isAuthCallback = segments[0] === "auth-callback";
    const segList = segments as unknown as string[];

    if (session) {
      if (needsEmailVerification(session.user)) {
        const authChild = segList.length > 1 ? segList[1] : "";
        const onVerifyEmail = segments[0] === "(auth)" && authChild === "verify-email";
        if (!onVerifyEmail) {
          const em = session.user.email?.trim() ?? "";
          const qs = em ? `?email=${encodeURIComponent(em)}` : "";
          router.replace(`/(auth)/verify-email${qs}` as never);
        }
        return;
      }

      void seedNewUserProfile(session.user.id).catch(console.error);

      if (inAuthGroup) {
        router.replace("/(tabs)/home");
      }
      return;
    }

    if (!inAuthGroup && !isPublicLegal && !isAuthCallback) {
      router.replace("/(auth)/sign-in");
    }
  }, [isLoading, router, segments, session]);

  return { navigationTheme };
}

function RootLayoutInner() {
  const { navigationTheme } = useProtectedNavigation();
  const { session } = useAuthSession();

  useEffect(() => {
    void initAnalytics().catch(() => undefined);
    void trackEvent("app_opened");
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android" || !session?.user || needsEmailVerification(session.user)) {
      return;
    }
    void import("@/src/features/subscriptions/billingService")
      .then(({ restorePurchases }) => restorePurchases())
      .catch(() => undefined);
  }, [session?.user]);

  return (
    <ThemeProvider value={navigationTheme}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="auth-callback" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="upgrade" />
        <Stack.Screen name="stories" />
        <Stack.Screen name="blocked-users" />
        <Stack.Screen name="creator/[userId]" />
        <Stack.Screen name="privacy-policy" />
        <Stack.Screen name="terms-of-service" />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemePreferenceProvider>
        <RootLayoutInner />
      </ThemePreferenceProvider>
    </SafeAreaProvider>
  );
}
