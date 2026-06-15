# v1 Launch — Remaining Items (need your infrastructure / staged cutover)

Everything else from the audit is merged (PRs #15, #16, #17). These remaining
items either depend on infrastructure/secrets only you control, or are
production-breaking if flipped before the external pieces exist. None should be
applied blind. Each has a safe, ordered cutover.

---

## HTTPS App Links for OAuth (Fixes 9 + 12)

**Why staged:** changing the OAuth redirect to `https://pulsestudios.app/...`
breaks **all** sign-in until `assetlinks.json` is hosted and the Supabase/Google
consoles are updated. The custom scheme `soundpulse://auth-callback` works today.

**Cutover order (do not reorder):**
1. Host `https://pulsestudios.app/.well-known/assetlinks.json`:
   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": { "namespace": "android_app",
       "package_name": "com.soundpulseapp.android",
       "sha256_cert_fingerprints": ["<SHA256 from the PRODUCTION upload keystore>"] }
   }]
   ```
   Get the fingerprint: `keytool -list -v -keystore <upload-keystore> -alias <alias>`
   (or copy it from Play Console → Setup → App signing).
2. Add the intent filter in `app.config.js` android:
   ```js
   intentFilters: [{
     action: "VIEW", autoVerify: true,
     data: [{ scheme: "https", host: "pulsestudios.app", pathPrefix: "/auth-callback" }],
     category: ["BROWSABLE", "DEFAULT"],
   }]
   ```
   Build a new binary and confirm `adb shell pm get-app-links com.soundpulseapp.android`
   shows `verified`.
3. Add a web page at `https://pulsestudios.app/auth-callback` that, on mobile,
   deep-links into the app, and on desktop says "Open SoundPulse to continue".
4. Add `https://pulsestudios.app/auth-callback` to **Supabase → Auth → URL
   Configuration → Redirect URLs** and to the Google OAuth client's authorized
   redirect URIs.
5. Switch `AUTH_CALLBACK_URL` (src/features/auth/oauth.ts) and the backend
   `signupRedirectUrl()` default to the HTTPS URL. Ship.
6. **(Fix 12) — done in code.** The legacy `soundpulse://auth/sign-in` handling
   has been removed (`+native-intent.tsx` deleted; the rewrite helpers in
   `src/lib/appLinking.ts` and the `isOAuthCallbackUrl` `auth/sign-in` branch are
   gone). Remaining manual step: remove `soundpulse://auth/sign-in` from
   **Supabase → Auth → URL Configuration → Redirect URLs** (keep
   `soundpulse://auth-callback`).

---

## `purchase_token` sanitized view + REVOKE (Fix 8)

The client already stopped reading `purchase_token` (PR #15) and `user_id` is now
immutable, so the hijack vector is closed. This item is defense-in-depth to make
the column physically unreadable by `authenticated`.

**Risk:** revoking base-table SELECT can break premium detection for **every**
user if any read path is missed. Verify on staging first.

```sql
-- 1) View without the token, RLS-respecting (security_invoker).
CREATE VIEW public.subscriptions_self
  WITH (security_invoker = true) AS
  SELECT id, user_id, plan, status, expires_at, product_id, auto_renewing,
         updated_at, created_at
  FROM public.subscriptions;
GRANT SELECT ON public.subscriptions_self TO authenticated;

-- 2) Point every client read at the view (useIsPremium.ts, profile.tsx,
--    billingService.getCurrentSubscription) BEFORE the next step.

-- 3) Only after the app build using the view is live:
REVOKE SELECT ON public.subscriptions FROM authenticated, anon;
```
Test: a brand-new account, a free→paid upgrade, restore-purchases, and the
Profile plan badge — for a real session, not just service_role.

---

## Redis-backed rate limits (Fix 17)

**Implemented.** All limiters use a Redis store when `REDIS_URL` is set and fall
back to in-memory otherwise. The only remaining step is provisioning Redis on
Railway and setting `REDIS_URL`. See **`docs/REDIS_SETUP.md`**.

---

## versionCode single source of truth (Fix 19)

`app.config.js` no longer pins `versionCode` (removed in PR #15); EAS manages it
remotely (`cli.appVersionSource: "remote"` + production `autoIncrement`).

**Your local `app.json` has an uncommitted `versionCode`** — left untouched per
project policy (never stage your local `app.json`/`eas.json`). To finish:
remove `android.versionCode` from `app.json` in your own commit, then verify with
`eas build:version:get`. Add to README: "App versions are managed by EAS; do not
hand-edit versionCode."
