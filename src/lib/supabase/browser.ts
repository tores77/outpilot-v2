// Browser-side Supabase client. Used from Client Components (sign-in / sign-out).
// Anon key only — RLS + the allowed_users allowlist are the security boundary.
//
// Fase 0 · T004. A typed variant with the generated Database schema arrives
// with T005 (supabase gen types).

import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
