import { Link, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { signInWithEmail } from "@/src/features/auth/api";
import { signInWithGoogle } from "@/src/features/auth/oauth";
import { GoogleSignInButton } from "@/src/components/auth/GoogleSignInButton";
import { Button } from "@/src/components/core/Button";
import { Input } from "@/src/components/core/Input";
import { Screen } from "@/src/components/core/Screen";
import { useAppTheme } from "@/src/theme";

export default function SignInScreen() {
  const theme = useAppTheme();
  const params = useLocalSearchParams<{ error?: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  // Surface failures forwarded by the auth-callback route (?error=...).
  useEffect(() => {
    if (typeof params.error === "string" && params.error.trim()) {
      setErrorMessage(params.error.trim());
    }
  }, [params.error]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          justifyContent: "center",
          gap: theme.spacing.lg,
        },
        header: {
          ...theme.typography.header,
          color: theme.colors.textPrimary,
        },
        subtitle: {
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          marginTop: -theme.spacing.sm,
        },
        error: {
          ...theme.typography.caption,
          color: theme.colors.coral,
        },
        link: {
          ...theme.typography.body,
          color: theme.colors.sky,
          textAlign: "center",
        },
        forgotLink: {
          ...theme.typography.caption,
          color: theme.colors.sky,
          alignSelf: "flex-start",
        },
        dividerRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.md,
        },
        dividerLine: {
          flex: 1,
          height: 1,
          backgroundColor: theme.colors.border,
        },
        dividerText: {
          ...theme.typography.caption,
          color: theme.colors.textSecondary,
        },
      }),
    [theme]
  );

  const handleGoogleSignIn = async () => {
    setErrorMessage(null);
    setIsGoogleLoading(true);
    const { error, cancelled } = await signInWithGoogle();
    setIsGoogleLoading(false);
    if (cancelled) {
      return;
    }
    if (error) {
      setErrorMessage(error.message);
    }
  };

  const handleSignIn = async () => {
    setErrorMessage(null);

    if (!email || !password) {
      setErrorMessage("Please enter both email and password.");
      return;
    }

    setIsSubmitting(true);
    const { error } = await signInWithEmail(email.trim(), password);
    setIsSubmitting(false);

    if (error) {
      const raw = error.message ?? "";
      const lower = raw.toLowerCase();
      if (lower.includes("email not confirmed") || lower.includes("not confirmed")) {
        setErrorMessage(
          "Confirm your email before signing in. Check your inbox or use Sign up to resend the link."
        );
      } else {
        setErrorMessage(raw);
      }
    }
  };

  return (
    <Screen>
      <View style={styles.container}>
        <Text style={styles.header}>Welcome Back</Text>
        <Text style={styles.subtitle}>Sign in to continue with SoundPulse.</Text>

        <GoogleSignInButton
          onPress={handleGoogleSignIn}
          loading={isGoogleLoading}
          disabled={isSubmitting}
        />

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <Input
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
        />
        <Input
          autoCapitalize="none"
          autoComplete="password"
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <Link href="/(auth)/forgot-password" style={styles.forgotLink}>
          Forgot password?
        </Link>

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

        {isSubmitting ? (
          <ActivityIndicator color={theme.colors.sky} />
        ) : (
          <Button label="Sign In" onPress={handleSignIn} disabled={isGoogleLoading} />
        )}

        <Link href="/(auth)/sign-up" style={styles.link}>
          Create an account
        </Link>
      </View>
    </Screen>
  );
}
