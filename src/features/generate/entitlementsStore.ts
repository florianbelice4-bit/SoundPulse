// AI generation is a premium-only feature. The backend grants free accounts 0
// generations (reserve_generation_slot returns false), so the app must not
// promise any. Keep in sync with railway generationLimits.ts (free = 0).
//
// (The former zustand entitlements store here was unused dead code and was
// removed; only this constant is consumed, by the Profile usage display.)
export const FREE_AI_GENERATIONS_PER_MONTH = 0;
