import * as FileSystem from "expo-file-system/legacy";
import { Platform, Share } from "react-native";

import { backendJsonHeaders, ensureBackendUrl } from "@/src/lib/backend";
import { fetchWithTimeout, RequestTimeoutError } from "@/src/lib/fetchWithTimeout";
import { supabase } from "@/src/lib/supabase";

async function authedHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    throw new Error("Sign in to manage your account.");
  }
  return backendJsonHeaders(token);
}

function networkMessage(error: unknown): string {
  return error instanceof RequestTimeoutError
    ? error.message
    : "Couldn't reach the server. Check your connection and try again.";
}

/** Permanently delete the signed-in user's account (storage + DB + auth). */
export async function deleteAccount(): Promise<void> {
  const headers = await authedHeaders();
  const baseUrl = ensureBackendUrl();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${baseUrl}/v1/account`, {
      method: "DELETE",
      headers,
      timeoutMs: 30000,
    });
  } catch (error) {
    throw new Error(networkMessage(error));
  }
  if (!res.ok) {
    throw new Error("Could not delete your account. Please try again.");
  }
}

/**
 * Download the user's data (GDPR/CCPA access) as JSON, save it to the app's
 * documents directory, and open the share sheet. Returns the saved file path.
 */
export async function exportAccountData(): Promise<string> {
  const headers = await authedHeaders();
  const baseUrl = ensureBackendUrl();
  let res: Response;
  try {
    res = await fetchWithTimeout(`${baseUrl}/v1/account/export`, {
      method: "GET",
      headers,
      timeoutMs: 30000,
    });
  } catch (error) {
    throw new Error(networkMessage(error));
  }
  if (!res.ok) {
    throw new Error("Could not export your data. Please try again.");
  }

  const json = await res.text();
  const dir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? "";
  const fileUri = `${dir}soundpulse-data-export.json`;
  await FileSystem.writeAsStringAsync(fileUri, json, { encoding: FileSystem.EncodingType.UTF8 });

  // iOS can share the file directly; Android's Share takes text, so send the
  // JSON inline when it's small (most exports are a few KB). The saved file is
  // always the durable copy regardless.
  await Share.share(
    Platform.OS === "ios"
      ? { url: fileUri, title: "SoundPulse data export" }
      : {
          title: "SoundPulse data export",
          message:
            json.length <= 200000
              ? json
              : "Your SoundPulse data export was saved to the app's files.",
        }
  ).catch(() => undefined);

  return fileUri;
}
