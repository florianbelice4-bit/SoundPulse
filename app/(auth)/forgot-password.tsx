import { Link } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Button } from "@/src/components/core/Button";
import { Input } from "@/src/components/core/Input";
import { Screen } from "@/src/components/core/Screen";
import { sendPasswordResetEmail } from "@/src/features/auth/api";
import { useAppTheme } from "@/src/theme";

export default function ForgotPasswordScreen() {
  const theme = useAppTheme();
  const [email, setEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
          lineHeight: 22,
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
      }),
    [theme]
  );

  const handleSendReset = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!email.trim()) {
      setErrorMessage("Please enter your email.");
      return;
    }

    setIsSubmitting(true);
    const { error } = await sendPasswordResetEmail(email.trim());
    setIsSubmitting(false);

    if (error) {
      const msg = error.message.toLowerCase();
      // Never reveal whether an account exists. Surface only non-enumerating
      // failures (rate limiting); treat everything else as a neutral success.
      if (msg.includes("rate") || msg.includes("too many")) {
        setErrorMessage("Too many attempts. Please wait a moment and try again.");
        return;
      }
    }

    setSuccessMessage("If an account exists for this email, we've sent a reset link.");
  };

  return (
    <Screen>
      <View style={styles.container}>
        <Text style={styles.header}>Reset password</Text>
        <Text style={styles.subtitle}>Enter your email and we will send you a link to choose a new password.</Text>

        <Input
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
        />

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
        {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}

        {isSubmitting ? (
          <ActivityIndicator color={theme.colors.sky} />
        ) : (
          <Button label="Send Reset Link" onPress={handleSendReset} />
        )}

        <Link href="/(auth)/sign-in" style={styles.link}>
          Back to Sign In
        </Link>
      </View>
    </Screen>
  );
}
