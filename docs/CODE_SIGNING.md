# Expo Updates Code Signing (OTA)

Signed OTA updates mean the app **only applies updates signed by a private key you
hold**. Even if an EAS/Expo account is compromised, an attacker can't push
malicious JS to users without that key.

## How it's wired here

`app.config.js` enables signing **automatically once the public certificate
exists**:

```js
const updatesCodeSigning = fs.existsSync("certs/certificate.pem")
  ? { codeSigningCertificate: "./certs/certificate.pem",
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" } }
  : {};
// → spread into expo.updates
```

So **until the certificate is generated and committed, signing is off** and
everything (`expo start`, `eas build`, dev) works normally. The moment
`certs/certificate.pem` is committed, production builds embed it and verify every
update against it. You do **not** need to run `expo-updates codesigning:configure`
— the config already handles it; just generate the cert and commit it.

- Private keys: `keys/` is gitignored (and `*.pem` is too). **Never commit them.**
- Public cert: `certs/certificate.pem` is explicitly re-included so it *can* be
  committed.

---

## One-time setup (developer, on a trusted machine)

### 1. Generate the key pair + certificate

```bash
npx expo-updates codesigning:generate \
  --key-output-directory keys \
  --certificate-output-directory certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name "Pulse Studios"
```

Creates:
- `keys/private-key.pem` — **NEVER commit. Back this up (below).**
- `keys/public-key.pem` — keep with the private key; not committed.
- `certs/certificate.pem` — **public; commit this.**

### 2. Add the private key as an EAS secret (for cloud `eas update`)

```bash
eas secret:create \
  --scope project \
  --name EXPO_UPDATES_PRIVATE_KEY \
  --type file \
  --value ./keys/private-key.pem
```

A `file` secret is mounted during EAS jobs; its path is exposed via
`$EXPO_UPDATES_PRIVATE_KEY`.

### 3. Commit the certificate

```bash
git add certs/certificate.pem
git commit -m "Add OTA code signing certificate"
```

This is the **public** certificate — safe to commit. (The next production build
will embed it and start enforcing signature verification.)

### 4. Back up the private key

Store `keys/private-key.pem` somewhere durable and private:
- ✅ 1Password / Bitwarden vault (team-shared item)
- ✅ Encrypted USB drive kept offline
- ❌ Never email, Slack, Drive/Dropbox, or any chat/issue tracker

Losing it means you can't sign new updates (see Recovery below).

---

## Publishing signed updates

`eas update` must be given the private key to sign:

```bash
# Local (key on disk)
eas update --branch production --message "..." --private-key-path keys/private-key.pem

# On EAS / CI (uses the file secret from step 2)
eas update --branch production --message "..." --private-key-path "$EXPO_UPDATES_PRIVATE_KEY"
```

If the cert is committed but the update isn't signed, clients on a signed build
will **reject** it — so always pass the key once signing is on.

---

## Ongoing maintenance

### When to rotate
- The 10-year cert rarely needs routine rotation.
- Rotate immediately on suspected key compromise, or when offboarding someone who
  had private-key access.

### Rotating keys (planned)
1. Generate a new key pair + certificate (step 1, into a temp dir).
2. Replace `certs/certificate.pem`, update the `EXPO_UPDATES_PRIVATE_KEY` secret.
3. **Ship a new production build** with the new certificate. Existing installs
   only trust the cert they shipped with, so until users update the binary, sign
   updates for old builds with the **old** key (or stop OTA'ing old builds).
4. Retire the old key once old builds are below your support threshold.

### Recovery if the private key is lost
- You cannot sign updates for already-released signed builds. Path forward: cut a
  new build with a fresh certificate (rotation above) and move users onto it.
  Plan around the install base that can't receive OTA until they update.

### If the key is compromised
1. Revoke access / rotate the EAS account credentials.
2. Generate a new key + cert, update the secret, and ship a new build ASAP.
3. Audit recent `eas update` activity for anything you didn't publish.

---

## Troubleshooting

**"Update failed signature verification" on device**
- The update wasn't signed, or was signed with a key that doesn't match the cert
  in the installed build. Re-run `eas update … --private-key-path …` with the
  correct key. Confirm the build embedded the cert (see Verify below).

**"Code signing certificate … not found" / config error**
- `certs/certificate.pem` is referenced but missing. Either generate+commit it, or
  (intentionally) leave it absent — the config auto-omits signing when it's not
  there.

**`eas update` errors about a missing private key**
- You committed the cert (signing is on) but didn't pass `--private-key-path`.
  Provide the key as shown above.

**Verify signing is actually on**
- `npx expo config --type introspect | grep -i codeSigning` should show
  `codeSigningCertificate` once the cert is committed (and nothing before).
- After a signed `eas update`, install the production build and confirm the update
  applies. Then publish an **unsigned** update to a throwaway branch and confirm
  the app **rejects** it.

---

## Manual setup checklist

- [ ] `npx expo-updates codesigning:generate …` (step 1)
- [ ] Back up `keys/private-key.pem` to the password manager (step 4)
- [ ] `eas secret:create … EXPO_UPDATES_PRIVATE_KEY … --type file` (step 2)
- [ ] `git add certs/certificate.pem && commit` (step 3)
- [ ] Build a production binary (embeds the cert)
- [ ] `eas update --branch production --private-key-path …` and confirm it loads
- [ ] Confirm an unsigned update to a test branch is rejected
