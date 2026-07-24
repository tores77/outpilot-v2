"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function LoginButton() {
  const [pending, setPending] = useState(false);

  const handleLogin = async () => {
    setPending(true);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setPending(false);
      console.error("signInWithOAuth error", error);
    }
    // On success, Supabase redirects the browser away; no state to clear.
  };

  return (
    <button
      type="button"
      onClick={handleLogin}
      disabled={pending}
      className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Redirigiendo…" : "Entrar con Google"}
    </button>
  );
}
