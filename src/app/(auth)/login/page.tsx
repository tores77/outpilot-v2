import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { LoginButton } from "./login-button";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied:
    "Tu correo no está autorizado para acceder a OUTPILOT. Contacta con Pere si crees que debería estarlo.",
  missing_code:
    "El flujo de OAuth no devolvió un código. Vuelve a intentarlo.",
  exchange_failed:
    "No se pudo canjear el código de OAuth con Supabase. Vuelve a intentarlo.",
  no_email:
    "La cuenta de Google no expuso un email. Prueba con otra cuenta.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user?.email) {
    const { data: allowed } = await supabase
      .from("allowed_users")
      .select("email")
      .eq("email", user.email)
      .maybeSingle();
    if (allowed) redirect("/");
  }

  const { error } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] : null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-10">
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">OUTPILOT v2</h1>
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted">
          Umania Labs
        </p>
        <p className="pt-2 text-sm text-foreground/60">
          Herramienta interna. Acceso restringido a la allowlist.
        </p>
      </div>
      <LoginButton />
      {errorMessage && (
        <p
          className="max-w-sm text-center text-sm text-red-400"
          role="alert"
        >
          {errorMessage}
        </p>
      )}
    </main>
  );
}
