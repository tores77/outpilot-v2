"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const handleSignOut = async () => {
    setPending(true);
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={pending}
      className="rounded-md border border-hairline px-3 py-1.5 text-xs text-foreground/70 transition-colors hover:border-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Cerrando…" : "Cerrar sesión"}
    </button>
  );
}
