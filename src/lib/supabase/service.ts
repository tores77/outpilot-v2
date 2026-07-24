// RLS-bypassing Supabase client. Uses SUPABASE_SERVICE_ROLE_KEY.
//
// IMPORTANT — ONLY IMPORTABLE FROM /jobs/**.
//
// This client ignores Row Level Security. Every query MUST filter by
// tenant_id explicitly; a query in /jobs/** without .eq('tenant_id', ...)
// will fail the T009 lint rule and CI.
//
// No cookie storage, no session refresh: this is a server-only client for
// Inngest job handlers and other trusted server contexts. Not for use in
// Server Components, Route Handlers wired to the user session, or the
// browser.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export function createSupabaseServiceClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
