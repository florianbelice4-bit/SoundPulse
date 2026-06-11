/**
 * Subscription plan tiers used for entitlement decisions. The Claude-model and
 * audio-transcription helpers that used to live here were StudyPulse carryover
 * and unused in SoundPulse — removed. Generation limits live in
 * generationLimits.ts; Play product → tier mapping lives in playProducts.ts.
 */
export type PlanTier =
  | "free"
  | "basic"
  | "student"
  | "semester"
  | "pro"
  | "pro_weekly"
  | "yearly"
  | "unlimited"
  | "lifetime";
