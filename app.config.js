const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, ".env"),
});

const appJson = require("./app.json");

const basePlugins = appJson.expo.plugins || [];
const plugins = Array.from(
  new Set([...basePlugins, "expo-iap", "./plugins/withReactNativeSvg", "./plugins/withForegroundService"])
);

// OTA code signing turns on automatically once the public certificate has been
// generated and committed (see docs/CODE_SIGNING.md). Until then these fields are
// omitted so the config still resolves — dev, `expo start`, and `eas build` all
// work without a certificate present. `eas update` will sign once the cert is in.
const codeSigningCertPath = path.resolve(__dirname, "certs/certificate.pem");
const updatesCodeSigning = fs.existsSync(codeSigningCertPath)
  ? {
      codeSigningCertificate: "./certs/certificate.pem",
      codeSigningMetadata: {
        keyid: "main",
        alg: "rsa-v1_5-sha256",
      },
    }
  : {};

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  expo: {
    ...appJson.expo,
    scheme: "soundpulse",
    cli: {
      appVersionSource: "remote",
    },
    updates: {
      url: "https://u.expo.dev/1ca89701-a6a7-4b1b-97cb-51311f7ed9b9",
      ...updatesCodeSigning,
    },
    runtimeVersion: {
      policy: "appVersion",
    },
    android: {
      ...appJson.expo.android,
      package: "com.soundpulseapp.android",
      // versionCode is managed remotely by EAS (cli.appVersionSource: "remote"
      // + production autoIncrement), so it is intentionally not pinned here.
      // Keep cloud/adb backups from capturing app data (incl. the AsyncStorage
      // auth-token fallback path).
      allowBackup: false,
      // We don't use the advertising ID; block it so SDKs can't pull it in and
      // to keep the Play Data Safety form accurate.
      blockedPermissions: ["com.google.android.gms.permission.AD_ID"],
      permissions: [
        "INTERNET",
        "com.android.vending.BILLING",
        "FOREGROUND_SERVICE",
        "FOREGROUND_SERVICE_MEDIA_PLAYBACK",
        "WAKE_LOCK",
      ],
    },
    plugins,
    extra: {
      backendUrl: process.env.EXPO_PUBLIC_BACKEND_URL,
      appSecretKey: process.env.EXPO_PUBLIC_APP_KEY,
      sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
      posthogKey: process.env.EXPO_PUBLIC_POSTHOG_KEY,
      posthogHost: process.env.EXPO_PUBLIC_POSTHOG_HOST,
      eas: {
        projectId: "1ca89701-a6a7-4b1b-97cb-51311f7ed9b9",
      },
    },
  },
};
