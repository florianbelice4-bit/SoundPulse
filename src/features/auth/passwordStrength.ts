export const PASSWORD_MIN_LENGTH = 10;

export type PasswordChecks = {
  length: boolean;
  letter: boolean;
  number: boolean;
  upperLower: boolean;
};

export type PasswordStrength = {
  checks: PasswordChecks;
  /** 0–4 */
  score: number;
  label: "Too weak" | "Weak" | "Fair" | "Strong";
  /** Meets the minimum requirements to submit (length + letter + number). */
  acceptable: boolean;
};

export function evaluatePassword(password: string): PasswordStrength {
  const checks: PasswordChecks = {
    length: password.length >= PASSWORD_MIN_LENGTH,
    letter: /[a-zA-Z]/.test(password),
    number: /[0-9]/.test(password),
    upperLower: /[a-z]/.test(password) && /[A-Z]/.test(password),
  };

  const score =
    (checks.length ? 1 : 0) +
    (checks.letter ? 1 : 0) +
    (checks.number ? 1 : 0) +
    (checks.upperLower || /[^a-zA-Z0-9]/.test(password) ? 1 : 0);

  const label = score <= 1 ? "Too weak" : score === 2 ? "Weak" : score === 3 ? "Fair" : "Strong";
  const acceptable = checks.length && checks.letter && checks.number;

  return { checks, score, label, acceptable };
}

/** Server-aligned validation message, or null when acceptable. */
export function passwordError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}
