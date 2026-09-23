"use client";

import { useFormStatus } from "react-dom";

// Client Component mínimo para el botón "Personalizar" de /campaigns.
// useFormStatus dentro del <form> del padre da el `pending` mientras
// la server action está en vuelo; deshabilitamos el botón y cambiamos
// el texto a "Encolando…". Sin esto → el usuario clica N veces al no
// ver feedback → N events → N runs (bug real observado el 2026-09-23).
export function PersonalizeButton({
  label,
  title,
}: {
  label: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      title={title}
      className="rounded-md border border-hairline bg-background px-3 py-1 text-xs text-foreground transition-colors hover:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Encolando…" : label}
    </button>
  );
}
