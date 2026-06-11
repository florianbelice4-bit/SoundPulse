# Dependency Audit (v1 launch)

Run `npm audit` in the repo root (mobile) and in `railway/backend`.

## Backend (`railway/backend`)

`npm audit fix` (non-breaking) was applied and resolved the **`qs`** DoS
advisory (GHSA-q8mj-m7cp-5q26). The lockfile change is committed.

**Remaining (4 moderate, not fixed — deliberately):** `uuid` <11.1.1 via
`gaxios`/`googleapis-common`/`googleapis`.
- **Advisory:** missing buffer bounds check in uuid v3/v5/v6 *when the caller
  passes a `buf` argument*.
- **Exploitable here?** No. `googleapis` generates request IDs without passing a
  caller-controlled `buf`, and we never call uuid directly. There is no
  user-controlled path to the vulnerable code.
- **Why not fixed:** the only fix is `npm audit fix --force`, which bumps
  `googleapis` 144 → 173 (a major, breaking upgrade). Not worth the regression
  risk for a non-exploitable advisory pre-launch.
- **Plan:** bump `googleapis` to the latest major in a dedicated post-launch PR
  and re-test Play verification + RTDN.

## Mobile (repo root)

**15 advisories (14 moderate, 1 critical) — all in Expo/Metro BUILD tooling,
none in the shipped app bundle.**

- **Critical: `shell-quote`** (`quote()` doesn't escape newlines). It's a
  transitive dep of the Metro/Expo CLI bundler. It runs on the **build machine**
  during `expo export`/`eas build`, never in the APK and never on user input at
  runtime. Not exploitable by app users.
- The moderate set (`@expo/config`, `@expo/config-plugins`, `@expo/prebuild-config`,
  `expo-constants`/`-asset`/`-linking`/`-manifests`/`-updates`) are all Expo SDK
  internals pulled by the toolchain.

**Do NOT run `npm audit fix` on the mobile project** — it bumps Expo packages off
the SDK 54-pinned versions and breaks the build. The correct tools are
`npx expo install --check` and `npx expo-doctor`. These advisories clear when
Expo ships patched SDK 54 point releases; track with `expo-doctor` each SDK bump.

## CI

Add a non-blocking audit step (informational, since the mobile findings are
build-time and expected):

```yaml
# .github/workflows/ci.yml (illustrative)
- run: npm audit --omit=dev || true            # mobile: informational
- run: cd railway/backend && npm audit --audit-level=high   # backend: fail on high+
```
