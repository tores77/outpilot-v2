"use client";

import { useFormStatus } from "react-dom";

// Botón para las acciones de Volt (crear campaña en Lemlist +
// sincronizar leads). Mismo patrón que PersonalizeButton de T022:
// useFormStatus deshabilita durante el submit y cambia el texto a
// "Encolando…". Evita el fan-out de clicks (aprendizaje T022 fix).
export function SyncButton({
  label,
  title,
  variant = "secondary",
}: {
  label: string;
  title?: string;
  variant?: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  const className =
    variant === "primary"
      ? "rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
      : "rounded-md border border-hairline bg-background px-3 py-1 text-xs text-foreground transition-colors hover:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-60";
  return (
    <button type="submit" disabled={pending} title={title} className={className}>
      {pending ? "Encolando…" : label}
    </button>
  );
}
