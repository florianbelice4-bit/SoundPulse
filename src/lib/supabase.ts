import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

import { createNativeSupabaseAuthStorage, SUPABASE_AUTH_STORAGE_KEY } from "./supabaseAuthStorage";

const storage = Platform.OS === "web" ? undefined : createNativeSupabaseAuthStorage();

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in environment."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storageKey: SUPABASE_AUTH_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    // PKCE so OAuth callbacks carry ?code= in the query string. The implicit
    // flow returns tokens in the URL #fragment, which deep-link query parsing
    // never sees. Email links sent without a code challenge (admin resend)
    // still arrive as fragment tokens — createSessionFromOAuthUrl handles both.
    flowType: "pkce",
    storage,
  },
});
