import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

// Placeholder home. The real dashboard chrome (Umania theme, nav, etc.)
// arrives with T010. For T004 this only needs to prove the two gates work:
//   1. no session  -> /login
//   2. session but not in allowed_users -> signOut + /login?error=access_denied
//   3. session and allowed -> shows who you are

export default async function Home() {
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-10 text-center">
      <h1 className="text-2xl font-semibold">OUTPILOT v2</h1>
      <p className="text-sm text-zinc-500">
        Sesión iniciada como{" "}
        <strong>{allowed.display_name ?? allowed.email}</strong> ({allowed.role}
        ).
      </p>
      <p className="max-w-md text-xs text-zinc-400">
        El chasis del dashboard (tema Umania, navegación) llega en T010. Esta
        pantalla es un placeholder para verificar el gate de allowlist.
      </p>
      <SignOutButton />
    </main>
  );
}
