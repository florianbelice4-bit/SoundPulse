import express, { type Request, type Response } from "express";

import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { signupRateLimit } from "../middleware/signupRateLimit.js";

export const authRouter = express.Router();

const MIN_PASSWORD_LEN = 10;
const MAX_PASSWORD_LEN = 128;

function isSuspiciousSignupEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return true;
  }

  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);

  if (local.includes("..") || domain.includes("..")) {
    return true;
  }
  if (/^(test|bot|spam|fake|admin|noreply)[+._-]?/i.test(local)) {
    return true;
  }

  const disposable = [
    "mailinator.com",
    "guerrillamail.com",
    "tempmail.com",
    "10minutemail.com",
    "throwaway.email",
    "yopmail.com",
  ];
  return disposable.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

function signupRedirectUrl(): string {
  // Must be a top-level Expo Router route — the (auth) group never appears in
  // URLs, so soundpulse://auth/sign-in has no matching route. Keep in sync
  // with AUTH_CALLBACK_URL in the app and the Supabase redirect allowlist.
  return process.env.SIGNUP_EMAIL_REDIRECT_URL?.trim() || "soundpulse://auth-callback";
}

authRouter.post("/signup", signupRateLimit, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const honeypot = typeof body.website === "string" ? body.website.trim() : "";
    if (honeypot.length > 0) {
      return res.status(400).json({
        error: "SIGNUP_REJECTED",
        message: "Sign-up could not be completed.",
      });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      return res.status(400).json({ error: "INVALID_REQUEST", message: "Email and password are required." });
    }
    if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: `Password must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters.`,
      });
    }
    // Require at least one letter and one number so a 10-char password can't be
    // all digits or all letters.
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Password must include at least one letter and one number.",
      });
    }
    if (password.toLowerCase() === email || password === email.split("@")[0]) {
      return res.status(400).json({
        error: "SIGNUP_REJECTED",
        message: "Choose a stronger password.",
      });
    }
    if (isSuspiciousSignupEmail(email)) {
      return res.status(400).json({
        error: "SIGNUP_REJECTED",
        message: "This email address cannot be used for sign-up.",
      });
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
    });

    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("already") || msg.includes("registered")) {
        // Anti-enumeration: respond exactly like a fresh signup so callers can't
        // tell whether the email is registered. The existing account is left
        // untouched and no new email is sent.
        return res.status(201).json({
          ok: true,
          userId: null,
          emailRedirectTo: signupRedirectUrl(),
          needsEmailVerification: true,
          confirmationEmailSent: false,
        });
      }
      console.error("[auth/signup]", error.message);
      return res.status(400).json({
        error: "SIGNUP_FAILED",
        message: "Could not create account. Check your email and try again.",
      });
    }

    // admin.createUser never emails the user. resend() pushes the signup
    // confirmation through Supabase's mailer for an unconfirmed account
    // (admin.generateLink only returns a link without sending anything).
    const { error: confirmationError } = await supabaseAdmin.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: signupRedirectUrl() },
    });
    if (confirmationError) {
      console.error("[auth/signup] confirmation email:", confirmationError.message);
    }

    return res.status(201).json({
      ok: true,
      userId: data.user?.id ?? null,
      emailRedirectTo: signupRedirectUrl(),
      needsEmailVerification: true,
      confirmationEmailSent: !confirmationError,
    });
  } catch (err) {
    console.error("[auth/signup]", err);
    return res.status(500).json({
      error: "SIGNUP_FAILED",
      message: "Sign-up failed. Please try again later.",
    });
  }
});
