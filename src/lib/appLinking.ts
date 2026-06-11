import * as Linking from "expo-linking";

/** Maps soundpulse://auth/* deep links to expo-router paths (see app/+native-intent.tsx). */
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

const AUTH_SIGN_IN_PATH = "auth/sign-in";

function splitPathAndSuffix(raw: string): { pathname: string; suffix: string } {
  const hashIdx = raw.indexOf("#");
  const queryIdx = raw.indexOf("?");
  let cut = raw.length;
  if (hashIdx >= 0) {
    cut = Math.min(cut, hashIdx);
  }
  if (queryIdx >= 0) {
    cut = Math.min(cut, queryIdx);
  }
  return {
    pathname: raw.slice(0, cut),
    suffix: raw.slice(cut),
  };
}

export function getDeepLinkPathname(url: string): string {
  try {
    const parsed = Linking.parse(url);
    const path = typeof parsed.path === "string" ? parsed.path.trim() : "";
    // URL parsing reads the first segment of a custom-scheme link as the
    // hostname (soundpulse://auth/sign-in → hostname "auth", path "sign-in"),
    // so stitch it back onto the pathname for soundpulse:// links.
    const scheme = (parsed.scheme ?? "").toLowerCase();
    const hostname = typeof parsed.hostname === "string" ? parsed.hostname.trim() : "";
    const joined =
      scheme === "soundpulse" && hostname
        ? `${hostname}/${path.replace(/^\/+/, "")}`.replace(/\/+$/, "")
        : path;
    return joined.replace(/^\/+/, "").toLowerCase();
  } catch {
    const withoutScheme = url.replace(/^soundpulse:\/\//i, "");
    const { pathname } = splitPathAndSuffix(withoutScheme);
    return pathname.replace(/^\/+/, "").toLowerCase();
  }
}

export function getDeepLinkSuffix(url: string): string {
  const withoutScheme = url.replace(/^soundpulse:\/\//i, "");
  return splitPathAndSuffix(withoutScheme).suffix;
}

export function isAuthSignInDeepLink(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  if (!url.toLowerCase().startsWith("soundpulse://")) {
    return false;
  }
  return getDeepLinkPathname(url) === AUTH_SIGN_IN_PATH;
}

/** Rewrite soundpulse://auth/sign-in → /(auth)/sign-in (preserves ?query and #hash for Supabase). */
export function resolveIncomingDeepLinkPath(path: string): string {
  if (!path || typeof path !== "string") {
    return path;
  }

  try {
    const fullUrl = path.includes("://") ? path : `soundpulse://${path.replace(/^\/+/, "")}`;
    if (!isAuthSignInDeepLink(fullUrl)) {
      return path;
    }

    const suffix = getDeepLinkSuffix(fullUrl);
    return `/(auth)/sign-in${suffix}`;
  } catch {
    return path;
  }
}
