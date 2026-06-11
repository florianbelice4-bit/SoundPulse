# Expo Updates Code Signing (OTA)

Signed updates prevent a compromised EAS account from pushing a malicious OTA
update: the app only applies updates signed by a key **you** hold.

> Keys must be generated and backed up by a human and never committed to the
> repo. This doc is the procedure; do not automate key generation in CI.

## Generate the key (once, on a trusted machine)

```bash
npx expo-updates codesigning:generate --key-output-directory keys --certificate-output-directory certs --certificate-validity-duration-years 10 --certificate-common-name "SoundPulse"
```

Produces `keys/private-key.pem`, `keys/public-key.pem`, `certs/certificate.pem`.

## Configure the app

```bash
npx expo-updates codesigning:configure --certificate-input-directory certs --key-input-directory keys
```

This adds to `app.json`/`app.config.js`:

```js
updates: {
  url: "https://u.expo.dev/<project-id>",
  codeSigningCertificate: "./certs/certificate.pem",
  codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
}
```

Commit `certs/certificate.pem` (public). **Never commit `keys/private-key.pem`.**

## Sign updates at publish time

```bash
eas update --private-key-path keys/private-key.pem --branch production --message "..."
```

(or set the private key path in EAS CI secrets, not in the repo).

## Back up the private key

- Store `keys/private-key.pem` in the team password manager / a sealed secret.
- Losing it means you must ship a new build with a new certificate before you can
  OTA again. Treat it like the upload keystore.

## Verify

After a signed `eas update`, install the production build and confirm the update
applies. Then temporarily publish an **unsigned** update to a test branch and
confirm the app **rejects** it.
