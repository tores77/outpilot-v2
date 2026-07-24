// Browser-side Supabase client. Used from Client Components (sign-in / sign-out).
// Anon key only — RLS + the allowed_users allowlist are the security boundary.

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
