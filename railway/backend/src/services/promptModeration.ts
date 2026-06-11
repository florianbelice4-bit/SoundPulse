/**
 * Curated v1 content blocklist for AI prompts and community text.
 *
 * This is intentionally a small, high-precision keyword filter — NOT a full
 * moderation system. It exists to keep clearly-prohibited content out of
 * generation and Discover for the Play Store launch. Replace/augment with a
 * real moderation API (e.g. an LLM classifier) in a later release.
 *
 * Matching is whole-word (\b boundaries) on a normalized string to limit
 * false positives (the "Scunthorpe problem"): "grass", "assistant", and
 * "class" must never trip a slur match.
 */

export type ModerationCategory =
  | "csam"
  | "sexual"
  | "hate"
  | "violence"
  | "self_harm"
  | "illegal";

export type ModerationResult =
  | { allowed: true }
  | { allowed: false; reason: string; category: ModerationCategory };

const GENERIC_REASON = "Content violates our guidelines";

/** Lowercase, fold common leetspeak, strip punctuation to spaces, collapse runs. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[4@]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordListMatcher(terms: string[]): RegExp {
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

// Standalone categories — a single match blocks the prompt.
const STANDALONE: { category: ModerationCategory; matcher: RegExp }[] = [
  {
    category: "sexual",
    matcher: wordListMatcher([
      "porn",
      "pornographic",
      "hardcore sex",
      "explicit sex",
      "blowjob",
      "cum shot",
      "cumshot",
      "gangbang",
      "creampie",
      "deepthroat",
    ]),
  },
  {
    // A small set of unambiguous slurs/hate phrases. Whole-word matched.
    category: "hate",
    matcher: wordListMatcher(["faggot", "kike", "chink", "spic", "tranny", "white power", "gas the jews"]),
  },
  {
    category: "violence",
    matcher: wordListMatcher([
      "school shooting",
      "mass shooting",
      "behead",
      "beheading",
      "ethnic cleansing",
      "genocide of",
    ]),
  },
  {
    category: "self_harm",
    matcher: wordListMatcher(["how to kill myself", "kill myself", "ways to suicide", "commit suicide", "slit my wrists"]),
  },
  {
    category: "illegal",
    matcher: wordListMatcher([
      "how to make a bomb",
      "build a bomb",
      "pipe bomb",
      "make meth",
      "cook meth",
      "child porn",
      "cp video",
    ]),
  },
];

// CSAM is detected by co-occurrence: a sexual/explicit term together with a
// minor indicator. This catches combinations a flat list would miss while
// avoiding blocking innocent uses of "child" or "sleep".
const MINOR_TERMS = wordListMatcher([
  "child",
  "children",
  "kid",
  "kids",
  "toddler",
  "infant",
  "baby",
  "preteen",
  "pre teen",
  "minor",
  "underage",
  "under age",
  "schoolgirl",
  "schoolboy",
  "loli",
  "shota",
]);
const SEXUAL_CONTEXT = wordListMatcher([
  "sex",
  "sexual",
  "sexy",
  "naked",
  "nude",
  "nudes",
  "porn",
  "explicit",
  "aroused",
  "erotic",
  "fondle",
  "molest",
  "rape",
]);
const AGE_UNDER_18 = /\b(?:[0-9]|1[0-7])\s*(?:year|yr)s?\s*old\b/;

export function moderatePrompt(input: string): ModerationResult {
  const text = typeof input === "string" ? normalize(input) : "";
  if (!text) {
    return { allowed: true };
  }

  const sexualPresent = SEXUAL_CONTEXT.test(text);
  const minorPresent = MINOR_TERMS.test(text) || AGE_UNDER_18.test(text);
  if (sexualPresent && minorPresent) {
    return { allowed: false, reason: GENERIC_REASON, category: "csam" };
  }

  for (const rule of STANDALONE) {
    if (rule.matcher.test(text)) {
      return { allowed: false, reason: GENERIC_REASON, category: rule.category };
    }
  }

  return { allowed: true };
}
