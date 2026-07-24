// Refreshes the Supabase Auth session on every request so Server Components
// and Route Handlers see up-to-date cookies. The Supabase SSR docs are
// explicit: getUser() MUST run here for cookie rotation to happen.
//
// Named `proxy` because Next 16 renamed the middleware file convention to
// proxy.ts. Same semantics; only the name changed.
//
// This proxy does NOT enforce the allowlist gate — that lives in the
// /auth/callback route (initial admission) and in the home page
// (per-navigation re-check). The proxy is only about session freshness.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Skip Next internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
