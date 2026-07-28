import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Sidebar } from "./sidebar";

// Server-side gate for every /(dashboard)/* route:
//   1. no session          -> /login
//   2. session, not allowed -> signOut + /login?error=access_denied
//   3. session and allowed  -> render chrome + child
//
// Runs on every navigation. Cheap: one auth.getUser() + one allowed_users
// select. The proxy already refreshes the cookie; this just enforces the
// allowlist per request.

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) redirect("/login");

  const { data: allowed } = await supabase
    .from("allowed_users")
    .select("email, display_name, role")
    .eq("email", user.email)
    .maybeSingle();

  if (!allowed) {
    await supabase.auth.signOut();
    redirect("/login?error=access_denied");
  }

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar
        displayName={allowed.display_name ?? allowed.email}
        role={allowed.role}
      />
      <main className="flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
