// Server-side Supabase client for Route Handlers, Server Components and
// Server Actions. Reads / writes the auth cookie via next/headers.
//
// Anon key only — every query still runs through RLS with the caller's JWT.
// The service_role client (RLS bypass) lives in ./service.ts and is only
// importable from /jobs/** (T009 lint rule).

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot mutate cookies. That is fine — the
            // proxy refreshes the session on every navigation.
          }
        },
      },
    },
  );
}
