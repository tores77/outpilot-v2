// OAuth callback + allowlist gate.
//
// Supabase Auth redirects the browser here after Google authenticates the
// user. We exchange the code for a session, read the user's email, and
// require an entry in allowed_users. If any step fails, we sign the user
// out so no stale session survives, and bounce back to /login with an
// error tag.
//
// RLS makes the allowlist check tamper-proof: even if this handler were
// wrong, the policy on allowed_users only returns rows for JWTs whose
// email is itself in the allowlist. Non-allowlisted users see an empty
// set and are rejected.

import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/login?error=${reason}`);

  if (!code) return fail("missing_code");

  const supabase = await createSupabaseServerClient();

  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    await supabase.auth.signOut();
    return fail("exchange_failed");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    await supabase.auth.signOut();
    return fail("no_email");
  }

  const { data: allowed } = await supabase
    .from("allowed_users")
    .select("email")
    .eq("email", user.email)
    .maybeSingle();

  if (!allowed) {
    await supabase.auth.signOut();
    return fail("access_denied");
  }

  return NextResponse.redirect(`${origin}${next}`);
}
