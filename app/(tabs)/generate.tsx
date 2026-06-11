import { Ionicons } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { Button } from "@/src/components/core/Button";
import { Card } from "@/src/components/core/Card";
import { Input } from "@/src/components/core/Input";
import { PlaybackTimer } from "@/src/components/audio/PlaybackTimer";
import { ResultsToast } from "@/src/components/core/ResultsToast";
import { Screen } from "@/src/components/core/Screen";
import { aiPreviewPlayer, formatAudioDuration } from "@/src/features/audio/aiPreviewPlayer";
import { layerMixerEngine } from "@/src/features/audio/layerMixerEngine";
import { onPlaybackStopped } from "@/src/features/audio/playbackRegistry";
import { useAuthSession } from "@/src/features/auth/useAuthSession";
import { inferTagsFromPrompt } from "@/src/features/community/categories";
import { shareMixToCommunity, shareSoundToCommunity } from "@/src/features/community/communityApi";
import { generateSoundscape, GenerateSoundscapeError } from "@/src/features/soundscapes/generateApi";
import {
  defaultLayerStates,
  layerStatesForEngine,
  layerStatesFromSnapshots,
  LAYER_PRESETS,
  snapshotsFromLayerStates,
  type LayerRowState,
  type SavedLayerSnapshot,
} from "@/src/features/mixer/layerPresets";
import { consumePendingMixLoad } from "@/src/features/mixer/pendingMixLoad";
import { fetchUserSavedMixes, saveUserMix, type SavedMixRow } from "@/src/features/mixer/savedMixesApi";
import { useIsPremium } from "@/src/features/subscription/useIsPremium";
import { useScrollContentBottomPad } from "@/src/hooks/useScrollBottomInset";
import { supabase } from "@/src/lib/supabase";
import { useAppTheme } from "@/src/theme";
import { trackEvent } from "@/src/lib/analytics";

type GenerateMode = "ai" | "mixer";

const EXAMPLE_PROMPTS = [
  "Rainy cabin with distant thunder",
  "Coffee shop with soft jazz",
  "Ocean waves at sunset",
  "Forest birds at dawn",
];

function sanitizeTitle(text: string, maxLen: number): string {
  const t = text.trim();
  if (!t) return "Generated soundscape";
  return t.length <= maxLen ? t : `${t.slice(0, maxLen)}…`;
}

function generatedSoundName(prompt: string): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length > 0 ? words.join(" ") : "Generated soundscape";
}

type AiGenerationResult = {
  title: string;
  prompt: string;
  url: string;
  duration: number;
};

export default function GenerateScreen() {
  const router = useRouter();
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();
  const theme = useAppTheme();
  const scrollBottomPad = useScrollContentBottomPad(24);
  const { session } = useAuthSession();
  const { isPremium, loading: premiumLoading } = useIsPremium();

  const [mode, setMode] = useState<GenerateMode>("ai");
  const [prompt, setPrompt] = useState("");
  const [paywallVisible, setPaywallVisible] = useState(false);
  const [paywallMessage, setPaywallMessage] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AiGenerationResult | null>(null);
  const [aiPlaying, setAiPlaying] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);
  const [shareToCommunity, setShareToCommunity] = useState(false);
  const [sharedToCommunity, setSharedToCommunity] = useState(false);
  const [sharingCommunity, setSharingCommunity] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  const [layers, setLayers] = useState<LayerRowState[]>(() => defaultLayerStates());
  const [mixPlaying, setMixPlaying] = useState(false);
  const [mixLoading, setMixLoading] = useState(false);
  const [savedMixes, setSavedMixes] = useState<SavedMixRow[]>([]);
  const [saveMixModalVisible, setSaveMixModalVisible] = useState(false);
  const [mixName, setMixName] = useState("");
  const [shareMixToCommunityToggle, setShareMixToCommunityToggle] = useState(false);
  const [savingMix, setSavingMix] = useState(false);
  const [mixesLoading, setMixesLoading] = useState(false);

  const layersRef = useRef(layers);
  layersRef.current = layers;
  const toastOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return onPlaybackStopped(() => {
      setAiPlaying(false);
      setMixPlaying(false);
    });
  }, []);

  const layerStatesForEngineCallback = useCallback(
    () => layerStatesForEngine(layersRef.current),
    []
  );

  const applyLayerSnapshots = useCallback((snapshots: SavedLayerSnapshot[]) => {
    setLayers(layerStatesFromSnapshots(snapshots));
    void layerMixerEngine.stopMix();
    setMixPlaying(false);
  }, []);

  const loadSavedMixes = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId) {
      setSavedMixes([]);
      return;
    }
    setMixesLoading(true);
    try {
      const mixes = await fetchUserSavedMixes(userId);
      setSavedMixes(mixes);
    } catch (e) {
      console.error("[Generate] Could not load saved mixes:", e);
    } finally {
      setMixesLoading(false);
    }
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      const pending = consumePendingMixLoad();
      if (pending) {
        setMode("mixer");
        applyLayerSnapshots(pending);
      } else if (modeParam === "mixer") {
        setMode("mixer");
      }
    }, [applyLayerSnapshots, modeParam])
  );

  useEffect(() => {
    if (mode === "mixer") {
      void loadSavedMixes();
    }
  }, [loadSavedMixes, mode]);

  const hasEnabledLayer = layers.some((l) => l.enabled);

  const styles = useMemo(() => stylesForTheme(theme), [theme]);

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

  const saveGeneratedSound = useCallback(async (result: AiGenerationResult, userId: string) => {
    const { error } = await supabase.from("generated_sounds").insert({
      user_id: userId,
      name: generatedSoundName(result.prompt),
      url: result.url,
      duration: Math.max(0, Math.round(result.duration)),
      prompt: result.prompt,
    });

    if (error) {
      throw error;
    }
  }, []);

  const startAiGeneration = useCallback(async () => {
    const raw = prompt.trim();
    if (!raw) return;

    const userId = session?.user?.id;
    if (!userId) {
      setAiError("Sign in to generate AI soundscapes.");
      return;
    }

    // AI generation is premium-only. Show the upgrade prompt up front instead of
    // letting the request hit the backend and fail. While premium status is
    // still loading we let it through — the backend remains the final gate.
    if (!isPremium && !premiumLoading) {
      setPaywallMessage("AI generation requires a paid plan. Upgrade to start generating sounds.");
      setPaywallVisible(true);
      return;
    }

    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    setAiPlaying(false);
    setAiSaved(false);
    setShareToCommunity(false);
    setSharedToCommunity(false);
    await aiPreviewPlayer.unload();

    try {
      const { url, duration } = await generateSoundscape(raw, userId);
      const loadedDuration = await aiPreviewPlayer.load(url);
      const resolvedDuration =
        loadedDuration > 0 ? loadedDuration : duration > 0 ? duration : 15;
      const nextResult = {
        title: sanitizeTitle(raw, 48),
        prompt: raw,
        url,
        duration: resolvedDuration,
      };
      setAiResult(nextResult);
      await saveGeneratedSound(nextResult, userId);
      setAiSaved(true);
      showToast("Sound saved to library");
    } catch (e) {
      if (e instanceof GenerateSoundscapeError) {
        if (
          e.code === "GENERATION_LIMIT_REACHED" ||
          e.code === "PAID_PLAN_REQUIRED" ||
          e.code === "EMAIL_NOT_VERIFIED"
        ) {
          if (e.code !== "EMAIL_NOT_VERIFIED") {
            setPaywallMessage(e.message);
            setPaywallVisible(true);
          }
        }
        setAiError(e.message);
      } else {
        setAiError(e instanceof Error ? e.message : "Generation failed");
      }
    } finally {
      setAiLoading(false);
    }
  }, [prompt, session?.user?.id, isPremium, premiumLoading, saveGeneratedSound, showToast]);

  const publishToCommunity = useCallback(
    async (result: AiGenerationResult, userId: string) => {
      setSharingCommunity(true);
      try {
        await shareSoundToCommunity({
          userId,
          title: result.title,
          prompt: result.prompt,
          audioUrl: result.url,
          duration: result.duration,
          tags: inferTagsFromPrompt(result.prompt),
        });
        setSharedToCommunity(true);
        showToast("Shared to community");
      } catch (e) {
        setShareToCommunity(false);
        setAiError(e instanceof Error ? e.message : "Could not share to community.");
      } finally {
        setSharingCommunity(false);
      }
    },
    [showToast]
  );

  const onShareToCommunityChange = useCallback(
    (enabled: boolean) => {
      if (enabled && !isPremium) {
        router.push("/upgrade");
        return;
      }
      setShareToCommunity(enabled);
      const userId = session?.user?.id;
      if (!enabled || !aiResult || !userId || sharedToCommunity || sharingCommunity) {
        return;
      }
      void publishToCommunity(aiResult, userId);
    },
    [aiResult, isPremium, publishToCommunity, router, session?.user?.id, sharedToCommunity, sharingCommunity]
  );

  const toggleAiPlay = useCallback(async () => {
    if (!aiResult?.url) return;
    const playing = await aiPreviewPlayer.toggle(aiResult.url);
    setAiPlaying(playing);
    if (playing) {
      void trackEvent("sound_played");
    }
  }, [aiResult?.url]);

  const saveAiResult = useCallback(async () => {
    const userId = session?.user?.id;
    if (!aiResult || !userId || aiSaved) return;
    try {
      await saveGeneratedSound(aiResult, userId);
      setAiSaved(true);
      showToast("Sound saved to library");
      void trackEvent("sound_saved");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Could not save sound.");
    }
  }, [aiResult, aiSaved, saveGeneratedSound, session?.user?.id, showToast]);

  const toggleMixerPlay = useCallback(async () => {
    if (layerMixerEngine.isPlaying() || mixPlaying) {
      await layerMixerEngine.stopMix();
      setMixPlaying(false);
      setMixLoading(false);
      return;
    }
    if (!hasEnabledLayer) {
      return;
    }
    setMixLoading(true);
    try {
      await layerMixerEngine.playMix(layerStatesForEngineCallback());
      setMixPlaying(layerMixerEngine.isPlaying());
      if (layerMixerEngine.isPlaying()) {
        void trackEvent("mix_played");
      }
    } catch (e) {
      console.error("[Generate] Mixer play failed:", e);
      setMixPlaying(false);
    } finally {
      setMixLoading(false);
    }
  }, [hasEnabledLayer, layerStatesForEngineCallback, mixPlaying]);

  const onLayerEnabledChange = useCallback((idx: number, enabled: boolean) => {
    setLayers((prev) => {
      const next = [...prev];
      const row = { ...next[idx]!, enabled };
      next[idx] = row;
      const preset = LAYER_PRESETS[idx];
      if (preset) {
        void trackEvent(enabled ? "layer_added" : "layer_removed", { layer_name: preset.key });
        void layerMixerEngine.applyLayerChange({
          key: preset.key,
          volume: row.volume,
          enabled: row.enabled,
        });
      }
      return next;
    });
  }, []);

  const onLayerVolumeChange = useCallback((idx: number, volume: number) => {
    const rounded = Math.round(volume);
    setLayers((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx]!, volume: rounded };
      return next;
    });
    const preset = LAYER_PRESETS[idx];
    if (!preset || !layersRef.current[idx]?.enabled) return;
    void layerMixerEngine.setLayerVolume(preset.key, rounded);
  }, []);

  const randomizeLayers = useCallback(() => {
    const pickCount = 3 + Math.floor(Math.random() * 2);
    const indices = [...Array(LAYER_PRESETS.length).keys()].sort(() => Math.random() - 0.5);
    const picked = new Set(indices.slice(0, pickCount));
    const next = LAYER_PRESETS.map((_, idx) => ({
      enabled: picked.has(idx),
      volume: picked.has(idx) ? 20 + Math.floor(Math.random() * 61) : (layersRef.current[idx]?.volume ?? 45),
    }));
    setLayers(next);
    void layerMixerEngine.stopMix();
    setMixPlaying(false);
    showToast("Layers randomized");
  }, [showToast]);

  const openSaveMixModal = useCallback(() => {
    if (!hasEnabledLayer) {
      return;
    }
    setMixName("");
    setShareMixToCommunityToggle(false);
    setSaveMixModalVisible(true);
  }, [hasEnabledLayer]);

  const confirmSaveMix = useCallback(async () => {
    const userId = session?.user?.id;
    const trimmedName = mixName.trim();
    if (!userId || !trimmedName) {
      setAiError("Enter a name for your mix.");
      return;
    }

    if (shareMixToCommunityToggle && !isPremium) {
      setSaveMixModalVisible(false);
      router.push("/upgrade");
      return;
    }

    setSavingMix(true);
    setAiError(null);
    try {
      const snapshots = snapshotsFromLayerStates(layers);
      const saved = await saveUserMix({
        userId,
        name: trimmedName,
        layers: snapshots,
      });

      void trackEvent("mix_saved");

      if (shareMixToCommunityToggle) {
        await shareMixToCommunity({
          userId,
          name: trimmedName,
          layers: snapshots,
          savedMixId: saved.id,
          tags: inferTagsFromPrompt(trimmedName),
        });
        showToast("Mix saved and shared to Discover");
      } else {
        showToast("Mix saved");
      }

      setSaveMixModalVisible(false);
      await loadSavedMixes();
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Could not save mix.");
    } finally {
      setSavingMix(false);
    }
  }, [
    isPremium,
    layers,
    loadSavedMixes,
    mixName,
    router,
    session?.user?.id,
    shareMixToCommunityToggle,
    showToast,
  ]);

  const loadSavedMix = useCallback(
    (mix: SavedMixRow) => {
      applyLayerSnapshots(mix.layers);
      showToast(`Loaded ${mix.name}`);
    },
    [applyLayerSnapshots, showToast]
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: scrollBottomPad }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.pageTitle}>Generate</Text>

        <View style={styles.modeRow}>
          <Pressable
            onPress={() => setMode("ai")}
            style={[styles.modePill, mode === "ai" && styles.modePillActive]}
            android_ripple={{ color: `${theme.colors.sky}44` }}
          >
            <Text style={[styles.modeText, mode === "ai" && styles.modeTextActive]}>AI Generate</Text>
            <View style={styles.proBadge}>
              <Ionicons name="lock-closed-outline" size={10} color={theme.colors.sky} />
              <Text style={styles.proBadgeText}>PRO</Text>
            </View>
          </Pressable>
          <Pressable
            onPress={() => setMode("mixer")}
            style={[styles.modePill, mode === "mixer" && styles.modePillActive]}
            android_ripple={{ color: `${theme.colors.sky}44` }}
          >
            <Text style={[styles.modeText, mode === "mixer" && styles.modeTextActive]}>Layer Mixer</Text>
          </Pressable>
        </View>

        <PlaybackTimer isPlaying={aiPlaying || mixPlaying} />

        {mode === "ai" ? (
          <>
            <Text style={styles.sectionLabel}>Prompt</Text>
            <Input
              placeholder='Describe your perfect sound…'
              placeholderTextColor={theme.colors.textSecondary}
              value={prompt}
              onChangeText={setPrompt}
              multiline
              numberOfLines={4}
              style={styles.promptInput}
            />

            <Text style={styles.examplesLabel}>Ideas</Text>
            <View style={styles.chipWrap}>
              {EXAMPLE_PROMPTS.map((line) => (
                <Pressable
                  key={line}
                  onPress={() => setPrompt(line)}
                  style={styles.chip}
                  android_ripple={{ color: `${theme.colors.primary}33` }}
                >
                  <Text style={styles.chipText}>{line}</Text>
                </Pressable>
              ))}
            </View>

            <View style={{ position: "relative" }}>
              {aiError ? <Text style={styles.aiError}>{aiError}</Text> : null}

              <Button
                label="Generate"
                onPress={() => void startAiGeneration()}
                disabled={aiLoading || !prompt.trim()}
                style={{ alignSelf: "stretch" }}
                premiumGlow
              />
              {aiLoading ? (
                <View style={styles.loadingCard}>
                  <ActivityIndicator color={theme.colors.sky} size="large" />
                  <Text style={styles.loadingCaption}>Generating your soundscape…</Text>
                </View>
              ) : null}
            </View>

            {aiResult ? (
              <Card>
                <Text style={styles.resultLabel}>Ready</Text>
                <Text style={styles.resultTitle}>{aiResult.title}</Text>
                <Text style={styles.durationBadge}>
                  {formatAudioDuration(aiResult.duration)} · loops
                </Text>
                <View style={styles.resultActions}>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => void toggleAiPlay()}
                    accessibilityRole="button"
                    accessibilityLabel={aiPlaying ? "Pause generated sound" : "Play generated sound"}
                  >
                    <Ionicons name={aiPlaying ? "pause-circle" : "play-circle"} size={44} color={theme.colors.primary} />
                  </Pressable>
                  <Text style={styles.playHint}>
                    {aiPlaying ? "Playing · looped preview" : "Tap to play · looped preview"}
                  </Text>
                </View>
                <Button
                  variant="secondary"
                  label={aiSaved ? "Saved to Library" : "Save to Library"}
                  onPress={() => void saveAiResult()}
                  disabled={aiSaved}
                />
                <View style={styles.shareRow}>
                  <View style={styles.shareCopy}>
                    <Text style={styles.shareLabel}>Share to Community</Text>
                    <Text style={styles.shareHint}>
                      {sharedToCommunity
                        ? "Visible on Discover for others to play and pulse."
                        : isPremium
                          ? "Let others discover and pulse your soundscape."
                          : "Premium required — upgrade to share with the community."}
                    </Text>
                  </View>
                  <Switch
                    value={shareToCommunity || sharedToCommunity}
                    onValueChange={onShareToCommunityChange}
                    disabled={sharedToCommunity || sharingCommunity}
                    thumbColor={shareToCommunity || sharedToCommunity ? theme.colors.primary : "#666"}
                    trackColor={{
                      false: theme.colors.border,
                      true: `${theme.colors.primary}88`,
                    }}
                  />
                </View>
              </Card>
            ) : null}
          </>
        ) : (
          <>
            <View style={styles.mixerTopBar}>
              <Text style={styles.mixerTopLabel}>Layer Mixer</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={mixPlaying ? "Pause mix" : "Play mix"}
                onPress={() => void toggleMixerPlay()}
                disabled={mixLoading || (!mixPlaying && !hasEnabledLayer)}
                style={[
                  styles.mixerTopPlayBtn,
                  mixPlaying && styles.mixerTopPlayBtnActive,
                  (mixLoading || (!mixPlaying && !hasEnabledLayer)) && styles.mixerTopPlayBtnDisabled,
                ]}
              >
                {mixLoading ? (
                  <ActivityIndicator color={theme.colors.primary} size="small" />
                ) : (
                  <Ionicons
                    name={mixPlaying ? "pause" : "play"}
                    size={22}
                    color={mixPlaying ? theme.colors.sky : theme.colors.primary}
                  />
                )}
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Randomize layers"
              onPress={randomizeLayers}
              style={styles.randomizeBtn}
            >
              <Ionicons name="shuffle" size={18} color={theme.colors.sky} />
              <Text style={styles.randomizeLabel}>Randomize</Text>
            </Pressable>

            <Card>
              <Text style={styles.sectionTitle}>Layers</Text>
              {LAYER_PRESETS.map((layer, idx) => {
                const row = layers[idx];
                const vol = row?.volume ?? 0;
                const on = row?.enabled ?? false;
                const isLastLayer = idx === LAYER_PRESETS.length - 1;
                return (
                  <View
                    key={layer.key}
                    style={[styles.layerRow, isLastLayer && { borderBottomWidth: 0, paddingBottom: 0 }]}
                  >
                    <View style={styles.layerHead}>
                      <Ionicons name={layer.icon} size={22} color={theme.colors.sky} />
                      <Text style={styles.layerLabel}>{layer.label}</Text>
                      <Switch
                        value={on}
                        onValueChange={(v) => onLayerEnabledChange(idx, v)}
                        thumbColor={on ? theme.colors.primary : "#666"}
                        trackColor={{
                          false: theme.colors.border,
                          true: `${theme.colors.primary}88`,
                        }}
                      />
                    </View>
                    <Slider
                      style={{ width: "100%", height: 40 }}
                      minimumValue={0}
                      maximumValue={100}
                      step={1}
                      value={vol}
                      disabled={!on}
                      minimumTrackTintColor={theme.colors.primary}
                      maximumTrackTintColor={theme.colors.border}
                      thumbTintColor={theme.colors.sky}
                      onValueChange={(value) => {
                        if (!on) {
                          return;
                        }
                        onLayerVolumeChange(idx, value);
                      }}
                    />
                    <Text style={styles.sliderValue}>{on ? `${Math.round(vol)}%` : "—"}</Text>
                  </View>
                );
              })}
            </Card>

            <View style={styles.mixerBtns}>
              <Button
                label={mixLoading ? "Loading…" : mixPlaying ? "Stop" : "Play"}
                variant="secondary"
                disabled={mixLoading || (!mixPlaying && !hasEnabledLayer)}
                onPress={() => void toggleMixerPlay()}
              />
              <Button
                label="Save Mix"
                premiumGlow
                disabled={!hasEnabledLayer}
                onPress={openSaveMixModal}
              />
              {mixPlaying ? (
                <Text style={styles.mixPlayingHint}>Mix playing · layers loop in the background.</Text>
              ) : !hasEnabledLayer ? (
                <Text style={styles.mixPlayingHint}>Enable at least one layer to play.</Text>
              ) : null}
            </View>

            <Card>
              <Text style={styles.sectionTitle}>My Mixes</Text>
              {mixesLoading ? (
                <ActivityIndicator color={theme.colors.primary} style={{ marginVertical: theme.spacing.md }} />
              ) : savedMixes.length === 0 ? (
                <Text style={styles.mixPlayingHint}>No saved mixes yet — save your current layers to reuse them.</Text>
              ) : (
                <View style={{ gap: theme.spacing.sm }}>
                  {savedMixes.map((mix) => (
                    <Pressable
                      key={mix.id}
                      onPress={() => loadSavedMix(mix)}
                      style={styles.savedMixRow}
                      accessibilityRole="button"
                      accessibilityLabel={`Load mix ${mix.name}`}
                    >
                      <Ionicons name="layers-outline" size={20} color={theme.colors.sky} />
                      <Text style={styles.savedMixName} numberOfLines={1}>
                        {mix.name}
                      </Text>
                      <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                  ))}
                </View>
              )}
            </Card>
          </>
        )}
      </ScrollView>

      <Modal visible={paywallVisible} transparent animationType="fade">
        <View style={styles.paywallBackdrop}>
          <Pressable style={styles.paywallBackdropFill} onPress={() => setPaywallVisible(false)} />
          <View style={styles.paywallCard}>
            <Text style={styles.paywallTitle}>Upgrade to generate</Text>
            <Text style={styles.paywallBody}>
              {paywallMessage ||
                "You've used all your AI generations this month. Upgrade to generate more."}
            </Text>
            <Button
              label="View plans"
              onPress={() => {
                setPaywallVisible(false);
                router.push("/upgrade");
              }}
              style={{ alignSelf: "stretch" }}
            />
            <Button variant="secondary" label="Maybe later" onPress={() => setPaywallVisible(false)} />
          </View>
        </View>
      </Modal>

      <Modal visible={saveMixModalVisible} transparent animationType="fade">
        <View style={styles.paywallBackdrop}>
          <Pressable style={styles.paywallBackdropFill} onPress={() => setSaveMixModalVisible(false)} />
          <View style={styles.paywallCard}>
            <Text style={styles.paywallTitle}>Save mix</Text>
            <Input
              placeholder="Mix name"
              value={mixName}
              onChangeText={setMixName}
              maxLength={48}
              autoCapitalize="words"
            />
            <View style={styles.shareRow}>
              <View style={styles.shareCopy}>
                <Text style={styles.shareLabel}>Share to Community</Text>
                <Text style={styles.shareHint}>
                  {isPremium
                    ? "Show this mix on Discover with a mixer icon."
                    : "Premium required to share mixes."}
                </Text>
              </View>
              <Switch
                value={shareMixToCommunityToggle}
                onValueChange={(enabled) => {
                  if (enabled && !isPremium) {
                    setSaveMixModalVisible(false);
                    router.push("/upgrade");
                    return;
                  }
                  setShareMixToCommunityToggle(enabled);
                }}
                thumbColor={shareMixToCommunityToggle ? theme.colors.primary : "#666"}
                trackColor={{
                  false: theme.colors.border,
                  true: `${theme.colors.primary}88`,
                }}
              />
            </View>
            <Button
              label={savingMix ? "Saving…" : "Save mix"}
              onPress={() => void confirmSaveMix()}
              disabled={savingMix || !mixName.trim()}
              style={{ alignSelf: "stretch" }}
            />
            <Button variant="secondary" label="Cancel" onPress={() => setSaveMixModalVisible(false)} />
          </View>
        </View>
      </Modal>
      <ResultsToast visible={toastVisible} message={toastMessage} opacityAnim={toastOpacity} theme={theme} />
    </Screen>
  );
}

function stylesForTheme(theme: ReturnType<typeof useAppTheme>) {
  return StyleSheet.create({
    scroll: { gap: theme.spacing.md, flexGrow: 1 },
    pageTitle: {
      ...theme.typography.header,
      color: theme.colors.textPrimary,
    },
    modeRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing.sm,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: `${theme.colors.primary}44`,
      alignSelf: "stretch",
    },
    modePill: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 6,
    },
    modePillActive: {
      backgroundColor: `${theme.colors.primary}37`,
      borderWidth: 1,
      borderColor: theme.colors.sky,
    },
    modeText: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontWeight: "700",
      fontSize: 14,
    },
    modeTextActive: {
      color: theme.colors.textPrimary,
    },
    proBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: `${theme.colors.sky}2a`,
      borderWidth: 1,
      borderColor: `${theme.colors.sky}99`,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    proBadgeText: {
      fontSize: 10,
      fontWeight: "800",
      color: theme.colors.sky,
      letterSpacing: 0.5,
    },
    quotaHint: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      textAlign: "center",
    },
    sectionLabel: {
      ...theme.typography.caption,
      color: theme.colors.sky,
      textTransform: "uppercase",
      letterSpacing: 0.9,
      fontWeight: "700",
    },
    promptInput: {
      minHeight: 120,
      textAlignVertical: "top",
      paddingTop: 12,
    },
    examplesLabel: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontWeight: "600",
      marginTop: theme.spacing.sm,
    },
    chipWrap: { gap: theme.spacing.sm, flexDirection: "column" },
    chip: {
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: `${theme.colors.sky}44`,
      backgroundColor: `${theme.colors.background}aa`,
      alignSelf: "stretch",
    },
    chipText: {
      ...theme.typography.body,
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    loadingCard: {
      marginTop: theme.spacing.md,
      paddingVertical: theme.spacing.xl,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    loadingCaption: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    aiError: {
      ...theme.typography.caption,
      color: theme.colors.coral,
      marginBottom: theme.spacing.sm,
    },
    resultLabel: {
      ...theme.typography.caption,
      color: theme.colors.sky,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    resultTitle: {
      ...theme.typography.title,
      fontSize: 20,
      color: theme.colors.textPrimary,
      marginBottom: theme.spacing.xs,
    },
    durationBadge: {
      ...theme.typography.caption,
      color: theme.colors.sky,
      marginBottom: theme.spacing.md,
      fontWeight: "600",
    },
    resultActions: {
      alignItems: "center",
      marginBottom: theme.spacing.md,
    },
    iconBtn: { padding: 8 },
    playHint: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      marginTop: 4,
    },
    shareRow: {
      marginTop: theme.spacing.md,
      paddingTop: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
    },
    shareCopy: {
      flex: 1,
      gap: 4,
    },
    shareLabel: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: "700",
    },
    shareHint: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    sectionTitle: {
      ...theme.typography.title,
      marginBottom: theme.spacing.md,
      color: theme.colors.primary,
    },
    mixerTopBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: theme.spacing.sm,
    },
    mixerTopLabel: {
      ...theme.typography.title,
      color: theme.colors.textPrimary,
      fontSize: 18,
    },
    mixerTopPlayBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: `${theme.colors.primary}66`,
      backgroundColor: `${theme.colors.primary}18`,
    },
    mixerTopPlayBtnActive: {
      borderColor: theme.colors.sky,
      backgroundColor: `${theme.colors.sky}22`,
    },
    mixerTopPlayBtnDisabled: {
      opacity: 0.45,
    },
    randomizeBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      alignSelf: "flex-start",
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: theme.radius.full,
      borderWidth: 1,
      borderColor: `${theme.colors.sky}55`,
      backgroundColor: `${theme.colors.primary}14`,
    },
    randomizeLabel: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: "700",
      fontSize: 14,
    },
    layerRow: {
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      gap: 4,
    },
    layerHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
    },
    layerLabel: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: "700",
      flex: 1,
    },
    sliderValue: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      textAlign: "right",
      marginBottom: theme.spacing.sm,
    },
    mixerBtns: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
    mixPlayingHint: {
      ...theme.typography.caption,
      color: theme.colors.sky,
      textAlign: "center",
    },
    savedMixRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      borderWidth: 1,
      borderColor: `${theme.colors.sky}33`,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      backgroundColor: `${theme.colors.background}80`,
    },
    savedMixName: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontWeight: "700",
      flex: 1,
    },
    paywallBackdrop: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: theme.spacing.lg,
    },
    paywallBackdropFill: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(10,10,15,0.88)",
    },
    paywallCard: {
      width: "100%",
      borderRadius: theme.radius.lg,
      padding: theme.spacing.xl,
      gap: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.sky,
      maxWidth: 400,
      alignSelf: "center",
      zIndex: 1,
    },
    paywallTitle: {
      ...theme.typography.title,
      fontSize: 22,
      color: theme.colors.textPrimary,
      textAlign: "center",
    },
    paywallBody: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      textAlign: "center",
      lineHeight: 22,
      marginBottom: theme.spacing.sm,
    },
  });
}
