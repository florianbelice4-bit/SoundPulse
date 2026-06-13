import { Link, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { signUpWithEmail } from "@/src/features/auth/api";
import { evaluatePassword, passwordError } from "@/src/features/auth/passwordStrength";
import { signInWithGoogle } from "@/src/features/auth/oauth";
import { GoogleSignInButton } from "@/src/components/auth/GoogleSignInButton";
import { seedNewUserProfile } from "@/src/features/auth/signupProfile";
import { Button } from "@/src/components/core/Button";
import { Input } from "@/src/components/core/Input";
import { Screen } from "@/src/components/core/Screen";
import { trackEvent } from "@/src/lib/analytics";
import { useAppTheme } from "@/src/theme";

export default function SignUpScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

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
        success: {
          ...theme.typography.caption,
          color: theme.colors.lime,
        },
        link: {
          ...theme.typography.body,
          color: theme.colors.sky,
          textAlign: "center",
        },
        agreeIntro: {
          ...theme.typography.caption,
          color: theme.colors.textSecondary,
          textAlign: "center",
          lineHeight: 20,
          marginTop: -theme.spacing.sm,
        },
        agreeLink: {
          color: theme.colors.sky,
          fontWeight: "600" as const,
          textDecorationLine: "underline" as const,
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

  const strength = useMemo(() => evaluatePassword(password), [password]);
  const strengthColor =
    strength.score <= 1
      ? theme.colors.coral
      : strength.score <= 2
        ? theme.colors.sky
        : theme.colors.lime;

  const handleGoogleSignIn = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsGoogleLoading(true);
    const { error, cancelled } = await signInWithGoogle();
    setIsGoogleLoading(false);
    if (cancelled) {
      return;
    }
    if (error) {
      setErrorMessage(error.message);
      void trackEvent("signed_up", { method: "google", ok: false });
      return;
    }
    void trackEvent("signed_up", { method: "google", ok: true });
  };

  const handleSignUp = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!email || !password || !confirmPassword) {
      setErrorMessage("Please complete all fields.");
      return;
    }

    const pwError = passwordError(password);
    if (pwError) {
      setErrorMessage(pwError);
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    const result = await signUpWithEmail(email.trim(), password);
    setIsSubmitting(false);

    if (!result.ok) {
      setErrorMessage(result.error ?? "Sign-up failed. Please try again.");
      void trackEvent("signed_up", { method: "email", ok: false, error_code: result.errorCode ?? null });
      return;
    }

    void trackEvent("signed_up", { method: "email", ok: true });

    if (result.userId) {
      try {
        await seedNewUserProfile(result.userId);
      } catch (trialError) {
        console.error("[sign-up] Failed to seed profile", trialError);
      }
    }

    if (result.needsEmailVerification) {
      const em = email.trim();
      router.replace(`/(auth)/verify-email?email=${encodeURIComponent(em)}` as never);
      return;
    }

    setSuccessMessage("Account created. You can sign in.");
  };

  return (
    <Screen>
      <View style={styles.container}>
        <Text style={styles.header}>Create Account</Text>
        <Text style={styles.subtitle}>Start using SoundPulse with your email.</Text>

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
          autoComplete="new-password"
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {password.length > 0 ? (
          <View style={{ gap: 4 }}>
            <Text style={{ ...theme.typography.caption, color: strengthColor, fontWeight: "700" }}>
              Password strength: {strength.label}
            </Text>
            <Text
              style={{
                ...theme.typography.caption,
                color: strength.checks.length ? theme.colors.lime : theme.colors.textSecondary,
              }}
            >
              {strength.checks.length ? "✓" : "•"} At least 8 characters
            </Text>
            <Text
              style={{
                ...theme.typography.caption,
                color:
                  strength.checks.letter && strength.checks.number
                    ? theme.colors.lime
                    : theme.colors.textSecondary,
              }}
            >
              {strength.checks.letter && strength.checks.number ? "✓" : "•"} Letters and numbers
            </Text>
            <Text
              style={{
                ...theme.typography.caption,
                color: strength.checks.upperLower ? theme.colors.lime : theme.colors.textSecondary,
              }}
            >
              {strength.checks.upperLower ? "✓" : "•"} Upper and lower case (recommended)
            </Text>
          </View>
        ) : null}

        <Input
          autoCapitalize="none"
          autoComplete="password"
          placeholder="Confirm Password"
          secureTextEntry
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
        {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}

        {isSubmitting ? (
          <ActivityIndicator color={theme.colors.sky} />
        ) : (
          <Button label="Sign Up" onPress={handleSignUp} disabled={isGoogleLoading} />
        )}

        <Text style={styles.agreeIntro}>
          By signing up you agree to our{" "}
          <Text style={styles.agreeLink} onPress={() => router.push("/terms-of-service")}>
            Terms of Service
          </Text>{" "}
          and{" "}
          <Text style={styles.agreeLink} onPress={() => router.push("/privacy-policy")}>
            Privacy Policy
          </Text>
          .
        </Text>

        <Link href="/(auth)/sign-in" style={styles.link}>
          Already have an account? Sign in
        </Link>
      </View>
    </Screen>
  );
}
