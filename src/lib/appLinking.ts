import * as Linking from "expo-linking";

/** Deep-link route map for the soundpulse:// scheme (expo-router). */
export const soundpulseLinking = {
  prefixes: [Linking.createURL("/"), "soundpulse://"],
  config: {
    screens: {
      index: "",
      "(auth)": {
        path: "auth",
        screens: {
          "sign-in": "sign-in",
          "sign-up": "sign-up",
          "verify-email": "verify-email",
          "forgot-password": "forgot-password",
        },
      },
      "(tabs)": {
        screens: {
          home: "home",
          generate: "generate",
          library: "library",
          profile: "profile",
        },
      },
    },
  },
} as const;
