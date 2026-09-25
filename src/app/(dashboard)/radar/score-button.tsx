"use client";

import { useFormStatus } from "react-dom";

// Client Component mínimo para el botón "Puntuar N pendientes" de /radar.
// Mismo patrón que PersonalizeButton (T022 fix): useFormStatus dentro
// del <form> del padre da el `pending` mientras la server action está
// en vuelo. Sin esto → el usuario clica N veces al no ver feedback →
// N events → 6 runs solapados (bug observado 2026-09-25).
//
// Estados visibles:
//   - Enabled  → "Puntuar N pendientes /total"
//   - pending  → "Encolando…" (form-submit en vuelo)
//   - processing (server-side) → "Puntuando N…" (el padre pasa el
//     count activeProcessing y el botón se renderiza deshabilitado).
export function ScoreButton({
  activePending,
  activeProcessing,
  batchSize,
  title,
}: {
  activePending: number;
  activeProcessing: number;
  batchSize: number;
  title?: string;
}) {
  const { pending: formPending } = useFormStatus();

  const isProcessing = activeProcessing > 0;
  const disabled = formPending || isProcessing;

  let label: string;
  if (formPending) {
    label = "Encolando…";
  } else if (isProcessing) {
    label = `Puntuando ${activeProcessing}…`;
  } else {
    const willProcess = Math.min(activePending, batchSize);
    label =
      activePending > batchSize
        ? `Puntuar ${willProcess} (de ${activePending})`
        : `Puntuar ${willProcess} pendientes`;
  }

  return (
    <button
      type="submit"
      disabled={disabled}
      title={title}
      className="rounded-md border border-hairline bg-background px-4 py-2 text-sm text-foreground transition-colors hover:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {label}
    </button>
  );
}
