import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { Button } from "@/src/components/core/Button";
import { Card } from "@/src/components/core/Card";
import { Input } from "@/src/components/core/Input";
import { ResultsToast } from "@/src/components/core/ResultsToast";
import { ProfileAvatar } from "@/src/components/profile/ProfileAvatar";
import { Screen } from "@/src/components/core/Screen";
import { signOut } from "@/src/features/auth/api";
import { useAuthSession } from "@/src/features/auth/useAuthSession";
import { submitFeedback, type FeedbackType } from "@/src/features/feedback/feedbackApi";
import { FREE_AI_GENERATIONS_PER_MONTH } from "@/src/features/generate/entitlementsStore";
import { updateProfileDisplayName } from "@/src/features/profile/profileApi";
import { SUBSCRIPTION_PLANS, type SubscriptionPlanId } from "@/src/features/subscription/plans";
import { isPremiumSubscription } from "@/src/features/subscription/subscriptionUtils";
import { useScrollContentBottomPad } from "@/src/hooks/useScrollBottomInset";
import { getAnalyticsOptOut, setAnalyticsOptOut, syncAnalyticsUserProperties, trackEvent } from "@/src/lib/analytics";
import { supabase } from "@/src/lib/supabase";
import { useAppTheme } from "@/src/theme";

type ProfileRow = {
  display_name: string | null;
  email: string | null;
};

type SubscriptionRow = {
  plan: string | null;
  status: string | null;
  expires_at: string | null;
  product_id?: string | null;
};

type ProfileData = {
  displayName: string;
  email: string;
  subscription: SubscriptionRow | null;
  generatedThisMonth: number;
};

function currentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    startIso: start.toISOString(),
    nextIso: next.toISOString(),
  };
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function subscriptionLabel(row: SubscriptionRow | null): "Free" | "Premium" {
  if (!row) {
    return "Free";
  }
  const status = row.status?.toLowerCase() ?? "";
  const plan = row.plan?.toLowerCase() ?? "";
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const stillActive = !expiresAt || expiresAt.getTime() > Date.now();
  const paidStatus = status === "active" || status === "trialing";
  return paidStatus && stillActive && plan !== "free" ? "Premium" : "Free";
}

function subscriptionDetail(row: SubscriptionRow | null): string {
  if (!row) {
    return "Free plan";
  }
  const plan = row.plan?.trim() ? titleCase(row.plan) : "Free";
  const status = row.status?.trim() ? titleCase(row.status) : "Unknown";
  if (!row.expires_at) {
    return `${plan} · ${status}`;
  }
  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    return `${plan} · ${status}`;
  }
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiresAt);
  return `${plan} · ${status} · Renews ${date}`;
}

function activePlanId(row: SubscriptionRow | null): SubscriptionPlanId | null {
  if (!row || !isPremiumSubscription(row)) {
    return null;
  }
  const plan = row.plan?.toLowerCase() ?? "";
  return plan === "basic" || plan === "pro" || plan === "unlimited" ? plan : null;
}

function billingSubscriptionLabel(row: SubscriptionRow | null): "Free" | "Basic" | "Pro" | "Unlimited" {
  const plan = activePlanId(row);
  return plan ? (titleCase(plan) as "Basic" | "Pro" | "Unlimited") : "Free";
}

function billingSubscriptionDetail(row: SubscriptionRow | null): string {
  const activePlan = activePlanId(row);
  if (!row || !activePlan) {
    return "Free plan";
  }

  const plan = titleCase(activePlan);
  const status = row.status?.trim() ? titleCase(row.status) : "Unknown";
  if (!row.expires_at) {
    return `${plan} - ${status}`;
  }

  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    return `${plan} - ${status}`;
  }

  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiresAt);
  const renewalLabel = row.status?.toLowerCase() === "canceled" ? "Access until" : "Renews";
  return `${plan} - ${status} - ${renewalLabel} ${date}`;
}

function fallbackDisplayName(email: string): string {
  const localPart = email.split("@")[0]?.trim();
  return localPart ? titleCase(localPart) : "SoundPulse listener";
}

function subscriptionManagementUrl(): string {
  if (Platform.OS === "ios") {
    return "https://apps.apple.com/account/subscriptions";
  }
  return "https://play.google.com/store/account/subscriptions";
}

export default function ProfileScreen() {
  const router = useRouter();
  const theme = useAppTheme();
  const scrollBottomPad = useScrollContentBottomPad(24);
  const { session } = useAuthSession();

  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [feedbackType, setFeedbackType] = useState<FeedbackType>("content");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [analyticsOptedOut, setAnalyticsOptedOut] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        scrollContent: {
          flexGrow: 1,
          gap: theme.spacing.lg,
          paddingBottom: scrollBottomPad,
        },
        header: {
          gap: theme.spacing.sm,
        },
        title: {
          ...theme.typography.header,
          color: theme.colors.textPrimary,
        },
        intro: {
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          lineHeight: 22,
        },
        profileCard: {
          borderColor: `${theme.colors.primary}55`,
          gap: theme.spacing.md,
        },
        profileTop: {
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.md,
        },
        identity: {
          flex: 1,
          minWidth: 0,
          gap: 4,
        },
        nameRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        editBtn: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: `${theme.colors.primary}55`,
          backgroundColor: `${theme.colors.primary}14`,
        },
        nameEditActions: {
          flexDirection: "row",
          gap: theme.spacing.sm,
          marginTop: theme.spacing.sm,
        },
        name: {
          ...theme.typography.title,
          color: theme.colors.textPrimary,
          fontSize: 22,
        },
        email: {
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          fontSize: 14,
        },
        sectionLabel: {
          ...theme.typography.caption,
          color: `${theme.colors.sky}cc`,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          fontWeight: "800",
        },
        planRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: theme.spacing.md,
        },
        planLeft: {
          flex: 1,
          minWidth: 0,
          gap: 5,
        },
        cardTitle: {
          ...theme.typography.title,
          color: theme.colors.textPrimary,
          fontSize: 19,
        },
        muted: {
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          lineHeight: 21,
        },
        badge: {
          borderRadius: theme.radius.full,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderWidth: 1,
          alignSelf: "flex-start",
        },
        badgeText: {
          ...theme.typography.caption,
          fontWeight: "900",
          textTransform: "uppercase",
          letterSpacing: 0.7,
        },
        statsGrid: {
          flexDirection: "row",
          gap: theme.spacing.md,
        },
        statTile: {
          flex: 1,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: `${theme.colors.sky}33`,
          backgroundColor: `${theme.colors.background}80`,
          padding: theme.spacing.md,
          gap: 8,
        },
        statIcon: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: `${theme.colors.sky}1f`,
        },
        statValue: {
          ...theme.typography.title,
          color: theme.colors.textPrimary,
          fontSize: 24,
        },
        statLabel: {
          ...theme.typography.caption,
          color: theme.colors.textSecondary,
          lineHeight: 18,
        },
        settingsCard: {
          gap: theme.spacing.md,
        },
        buttonStack: {
          gap: theme.spacing.sm,
        },
        errorText: {
          ...theme.typography.caption,
          color: theme.colors.coral,
          lineHeight: 20,
        },
        loadingState: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: theme.spacing.md,
          paddingVertical: theme.spacing.xxl,
        },
        legalRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          gap: theme.spacing.sm,
        },
        legalLink: {
          ...theme.typography.caption,
          color: theme.colors.sky,
          textDecorationLine: "underline",
        },
        legalSep: {
          ...theme.typography.caption,
          color: theme.colors.textSecondary,
        },
        feedbackTypeRow: {
          flexDirection: "row",
          gap: theme.spacing.sm,
        },
        feedbackTypeChip: {
          flex: 1,
          paddingVertical: 12,
          paddingHorizontal: 10,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          alignItems: "center",
        },
        feedbackTypeLabel: {
          ...theme.typography.caption,
          fontWeight: "800",
          fontSize: 13,
        },
        modalBackdrop: {
          flex: 1,
          backgroundColor: "#000000bb",
          justifyContent: "center",
          padding: theme.spacing.lg,
        },
        modalCard: {
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: `${theme.colors.primary}55`,
          backgroundColor: theme.colors.surface,
          padding: theme.spacing.lg,
          gap: theme.spacing.md,
        },
        modalTitle: {
          ...theme.typography.title,
          color: theme.colors.textPrimary,
          fontSize: 20,
        },
        modalHint: {
          ...theme.typography.body,
          color: theme.colors.textSecondary,
          lineHeight: 21,
        },
      }),
    [scrollBottomPad, theme]
  );

  const showToast = useCallback(
    (message: string) => {
      setToastMessage(message);
      setToastVisible(true);
      toastOpacity.stopAnimation();
      toastOpacity.setValue(0);
      Animated.sequence([
        Animated.timing(toastOpacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.delay(1800),
        Animated.timing(toastOpacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) {
          setToastVisible(false);
        }
      });
    },
    [toastOpacity]
  );

  const openFeedbackModal = useCallback(() => {
    setFeedbackType("content");
    setFeedbackMessage("");
    setFeedbackVisible(true);
    setErrorMessage(null);
  }, []);

  const closeFeedbackModal = useCallback(() => {
    if (submittingFeedback) {
      return;
    }
    setFeedbackVisible(false);
  }, [submittingFeedback]);

  const handleSubmitFeedback = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId) {
      setErrorMessage("Sign in to send feedback.");
      return;
    }
    setSubmittingFeedback(true);
    setErrorMessage(null);
    try {
      await submitFeedback(userId, feedbackType, feedbackMessage);
      setFeedbackVisible(false);
      setFeedbackMessage("");
      showToast("Thanks — we received your feedback");
      void trackEvent("feedback_submitted", { type: feedbackType });
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Could not send feedback.");
    } finally {
      setSubmittingFeedback(false);
    }
  }, [feedbackMessage, feedbackType, session?.user?.id, showToast]);

  useEffect(() => {
    void getAnalyticsOptOut().then(setAnalyticsOptedOut).catch(() => undefined);
  }, []);

  const loadProfile = useCallback(
    async ({ initial }: { initial: boolean }) => {
      const user = session?.user;
      if (!user) {
        setProfileData(null);
        setLoading(false);
        setErrorMessage(null);
        return;
      }

      if (initial) {
        setLoading(true);
      }
      setErrorMessage(null);

      const { startIso, nextIso } = currentMonthRange();

      const [profileResult, subscriptionResult, soundsResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("display_name,email")
          .eq("id", user.id)
          .maybeSingle<ProfileRow>(),
        supabase
          .from("subscriptions")
          .select("plan,status,expires_at,product_id")
          .eq("user_id", user.id)
          .order("expires_at", { ascending: false })
          .limit(1),
        supabase
          .from("generated_sounds")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("created_at", startIso)
          .lt("created_at", nextIso),
      ]);

      const errors = [profileResult.error, subscriptionResult.error, soundsResult.error].filter(Boolean);
      if (errors.length > 0) {
        setErrorMessage(errors[0]?.message ?? "Could not load profile.");
      }

      const profile = profileResult.data;
      const email = profile?.email?.trim() || user.email?.trim() || "Not signed in";
      const displayName = profile?.display_name?.trim() || fallbackDisplayName(email);
      const subscription = ((subscriptionResult.data ?? [])[0] as SubscriptionRow | undefined) ?? null;
      const planTier = (subscription?.plan ?? "free").trim() || "free";
      const trialActive = (subscription?.status ?? "").trim().toLowerCase() === "trialing";
      const createdAtIso = (user as unknown as { created_at?: string | null })?.created_at ?? null;
      void syncAnalyticsUserProperties({
        userId: user.id,
        planTier,
        trialActive,
        createdAtIso,
      });

      setProfileData({
        displayName,
        email,
        subscription,
        generatedThisMonth: soundsResult.count ?? 0,
      });
      setDraftName(displayName);

      if (initial) {
        setLoading(false);
      }
    },
    [session?.user]
  );

  useFocusEffect(
    useCallback(() => {
      void loadProfile({ initial: true });
    }, [loadProfile])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadProfile({ initial: false }).finally(() => setRefreshing(false));
  }, [loadProfile]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    const { error } = await signOut();
    setSigningOut(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    void trackEvent("signed_out");
    router.replace("/(auth)/sign-in");
  }, [router]);

  const handleManageSubscription = useCallback(() => {
    const url = subscriptionManagementUrl();
    Linking.openURL(url).catch(() => {
      Alert.alert("Manage subscription", "Open your app store account subscriptions to manage SoundPulse.");
    });
  }, []);

  const activePlan = activePlanId(profileData?.subscription ?? null);
  const planLabel = billingSubscriptionLabel(profileData?.subscription ?? null);
  const isPremium = Boolean(activePlan);
  const usageLimit = activePlan
    ? SUBSCRIPTION_PLANS.find((plan) => plan.id === activePlan)?.generationLimit
    : FREE_AI_GENERATIONS_PER_MONTH;
  const usageLimitLabel = String(usageLimit ?? FREE_AI_GENERATIONS_PER_MONTH);

  const openUpgrade = useCallback(() => {
    router.push("/upgrade");
  }, [router]);

  const startEditingName = useCallback(() => {
    setDraftName(profileData?.displayName ?? "");
    setEditingName(true);
    setErrorMessage(null);
  }, [profileData?.displayName]);

  const cancelEditingName = useCallback(() => {
    setEditingName(false);
    setDraftName(profileData?.displayName ?? "");
    setErrorMessage(null);
  }, [profileData?.displayName]);

  const saveDisplayName = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId) {
      return;
    }
    setSavingName(true);
    setErrorMessage(null);
    try {
      await updateProfileDisplayName(userId, draftName);
      setProfileData((prev) =>
        prev ? { ...prev, displayName: draftName.trim().replace(/\s+/g, " ") } : prev
      );
      setEditingName(false);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Could not update name.");
    } finally {
      setSavingName(false);
    }
  }, [draftName, session?.user?.id]);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary, theme.colors.sky]}
          />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>Profile</Text>
          <Text style={styles.intro}>Account, subscription, and generation usage.</Text>
        </View>

        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator color={theme.colors.primary} size="large" />
            <Text style={styles.muted}>Loading your profile...</Text>
          </View>
        ) : (
          <>
            <Card style={styles.profileCard}>
              <View style={styles.profileTop}>
                <ProfileAvatar
                  name={profileData?.displayName ?? "SoundPulse listener"}
                  size={62}
                />
                <View style={styles.identity}>
                  {editingName ? (
                    <>
                      <Input
                        value={draftName}
                        onChangeText={setDraftName}
                        autoCapitalize="words"
                        autoCorrect={false}
                        maxLength={32}
                        placeholder="Display name"
                      />
                      <View style={styles.nameEditActions}>
                        <Button
                          label={savingName ? "Saving…" : "Save"}
                          onPress={() => void saveDisplayName()}
                          disabled={savingName}
                          style={{ flex: 1 }}
                        />
                        <Button
                          label="Cancel"
                          variant="secondary"
                          onPress={cancelEditingName}
                          disabled={savingName}
                          style={{ flex: 1 }}
                        />
                      </View>
                    </>
                  ) : (
                    <View style={styles.nameRow}>
                      <Text style={[styles.name, { flex: 1 }]} numberOfLines={1}>
                        {profileData?.displayName ?? "SoundPulse listener"}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Edit display name"
                        onPress={startEditingName}
                        style={styles.editBtn}
                      >
                        <Ionicons name="pencil" size={16} color={theme.colors.primary} />
                      </Pressable>
                    </View>
                  )}
                  <Text style={styles.email} numberOfLines={1}>
                    {profileData?.email ?? "Not signed in"}
                  </Text>
                </View>
              </View>
              {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
            </Card>

            <Card style={styles.profileCard}>
              <Text style={styles.sectionLabel}>Subscription</Text>
              <View style={styles.planRow}>
                <View style={styles.planLeft}>
                  <Text style={styles.cardTitle}>{planLabel}</Text>
                  <Text style={styles.muted}>{billingSubscriptionDetail(profileData?.subscription ?? null)}</Text>
                </View>
                <View
                  style={[
                    styles.badge,
                    {
                      backgroundColor: isPremium ? `${theme.colors.primary}26` : `${theme.colors.sky}1f`,
                      borderColor: isPremium ? theme.colors.primary : `${theme.colors.sky}66`,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.badgeText,
                      { color: isPremium ? theme.colors.primary : theme.colors.sky },
                    ]}
                  >
                    {planLabel}
                  </Text>
                </View>
              </View>
            </Card>

            <View>
              <Text style={styles.sectionLabel}>Usage</Text>
            </View>
            <View style={styles.statsGrid}>
              <View style={styles.statTile}>
                <View style={styles.statIcon}>
                  <Ionicons name="sparkles" size={18} color={theme.colors.sky} />
                </View>
                <Text style={styles.statValue}>{profileData?.generatedThisMonth ?? 0}</Text>
                <Text style={styles.statLabel}>Sounds generated this month</Text>
              </View>
              <View style={styles.statTile}>
                <View style={styles.statIcon}>
                  <Ionicons name="infinite" size={18} color={theme.colors.sky} />
                </View>
                <Text style={styles.statValue}>{usageLimitLabel}</Text>
                <Text style={styles.statLabel}>
                  {isPremium ? `${planLabel} monthly limit` : "AI generations · upgrade to unlock"}
                </Text>
              </View>
            </View>

            <Card style={styles.settingsCard}>
              <Text style={styles.sectionLabel}>Settings</Text>
              <View style={styles.buttonStack}>
                {!isPremium ? (
                  <Button label="Upgrade to Premium" premiumGlow onPress={openUpgrade} />
                ) : null}
                <Button label="Manage subscription" variant="secondary" onPress={handleManageSubscription} />
                <Button
                  label="Blocked Users"
                  variant="secondary"
                  onPress={() => router.push("/blocked-users")}
                />
                <Button
                  label={signingOut ? "Signing out..." : "Sign out"}
                  variant="secondary"
                  disabled={signingOut}
                  onPress={() => void handleSignOut()}
                />
                <Button label="Send Feedback" variant="secondary" onPress={openFeedbackModal} />
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingVertical: 8,
                  }}
                >
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={{ ...theme.typography.body, color: theme.colors.textPrimary, fontWeight: "700" }}>
                      Analytics
                    </Text>
                    <Text style={{ ...theme.typography.caption, color: theme.colors.textSecondary, lineHeight: 18 }}>
                      Help improve SoundPulse by sending non-personal usage events.
                    </Text>
                  </View>
                  <Switch
                    value={!analyticsOptedOut}
                    onValueChange={(enabled) => {
                      const nextOptOut = !enabled;
                      setAnalyticsOptedOut(nextOptOut);
                      void setAnalyticsOptOut(nextOptOut);
                    }}
                    trackColor={{ false: theme.colors.border, true: `${theme.colors.primary}66` }}
                    thumbColor={Platform.OS === "android" ? theme.colors.surface : undefined}
                  />
                </View>
              </View>
            </Card>

            <Card style={styles.settingsCard}>
              <View style={styles.legalRow}>
                <Pressable onPress={() => router.push("/privacy-policy")}>
                  <Text style={styles.legalLink}>Privacy Policy</Text>
                </Pressable>
                <Text style={styles.legalSep}>|</Text>
                <Pressable onPress={() => router.push("/terms-of-service")}>
                  <Text style={styles.legalLink}>Terms</Text>
                </Pressable>
              </View>
            </Card>
          </>
        )}
      </ScrollView>

      <Modal visible={feedbackVisible} transparent animationType="fade" onRequestClose={closeFeedbackModal}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeFeedbackModal} accessibilityLabel="Close" />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Send feedback</Text>
            <Text style={styles.modalHint}>Tell us what content or features you would like in SoundPulse.</Text>
            <View style={styles.feedbackTypeRow}>
              {(
                [
                  { key: "content" as const, label: "Request Content" },
                  { key: "feature" as const, label: "Request Feature" },
                ] as const
              ).map((option) => {
                const active = feedbackType === option.key;
                return (
                  <Pressable
                    key={option.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => setFeedbackType(option.key)}
                    style={[
                      styles.feedbackTypeChip,
                      {
                        borderColor: active ? theme.colors.primary : `${theme.colors.sky}44`,
                        backgroundColor: active ? `${theme.colors.primary}28` : theme.colors.background,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.feedbackTypeLabel,
                        { color: active ? theme.colors.textPrimary : theme.colors.textSecondary },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Input
              placeholder="Describe your idea…"
              placeholderTextColor={theme.colors.textSecondary}
              value={feedbackMessage}
              onChangeText={setFeedbackMessage}
              multiline
              numberOfLines={4}
              style={{ minHeight: 100, textAlignVertical: "top" }}
            />
            <Button
              label={submittingFeedback ? "Sending…" : "Submit"}
              onPress={() => void handleSubmitFeedback()}
              disabled={submittingFeedback || !feedbackMessage.trim()}
            />
            <Button label="Cancel" variant="secondary" onPress={closeFeedbackModal} disabled={submittingFeedback} />
          </View>
        </View>
      </Modal>

      <ResultsToast visible={toastVisible} message={toastMessage} opacityAnim={toastOpacity} theme={theme} />
    </Screen>
  );
}
