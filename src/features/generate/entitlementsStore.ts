import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// AI generation is a premium-only feature. The backend grants 0 generations to
// free accounts (reserve_generation_slot returns false), so the app must not
// promise any. Keep in sync with railway generationLimits.ts (free = 0).
export const FREE_AI_GENERATIONS_PER_MONTH = 0;

type EntitlementsState = {
  isPremium: boolean;
  aiGenerationsMonthKey: string;
  aiGenerationsUsed: number;
  syncMonth: () => void;
  recordAiGenerationSuccess: () => void;
  canStartAiGeneration: () => boolean;
  setPremium: (value: boolean) => void;
};

export const useGenerateEntitlementsStore = create<EntitlementsState>()(
  persist(
    (set, get) => ({
      isPremium: false,
      aiGenerationsMonthKey: "",
      aiGenerationsUsed: 0,

      syncMonth: () => {
        const key = currentMonthKey();
        const s = get();
        if (s.aiGenerationsMonthKey !== key) {
          set({ aiGenerationsMonthKey: key, aiGenerationsUsed: 0 });
        }
      },

      canStartAiGeneration: () => {
        get().syncMonth();
        const s = get();
        if (s.isPremium) {
          return true;
        }
        return s.aiGenerationsUsed < FREE_AI_GENERATIONS_PER_MONTH;
      },

      recordAiGenerationSuccess: () => {
        const s = get();
        if (s.isPremium) {
          return;
        }
        get().syncMonth();
        set((state) => ({
          aiGenerationsUsed: state.aiGenerationsUsed + 1,
          aiGenerationsMonthKey: currentMonthKey(),
        }));
      },

      setPremium: (value: boolean) => set({ isPremium: value }),
    }),
    {
      name: "soundpulse-generate-entitlements",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        isPremium: s.isPremium,
        aiGenerationsMonthKey: s.aiGenerationsMonthKey,
        aiGenerationsUsed: s.aiGenerationsUsed,
      }),
    }
  )
);
