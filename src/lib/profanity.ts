/**
 * Client-side profanity check (UX deterrent for display names). Community
 * titles/prompts are enforced server-side in the backend; display names are
 * written directly to the DB, so this is a best-effort front-end guard with the
 * same curated list. Whole-word matched on a normalized string.
 */
const PROFANITY_TERMS = [
  "fuck",
  "fucking",
  "fucker",
  "motherfucker",
  "shit",
  "bullshit",
  "asshole",
  "bitch",
  "bastard",
  "cunt",
  "dick",
  "douche",
  "twat",
  "wanker",
  "slut",
  "whore",
];

const PROFANITY_RE = new RegExp(
  `\\b(?:${PROFANITY_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i"
);

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[4@]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsProfanity(input: string): boolean {
  const text = typeof input === "string" ? normalize(input) : "";
  return text ? PROFANITY_RE.test(text) : false;
}
