"use client";

import { useFormStatus } from "react-dom";

// Client Component minimo: solo el submit del form de /campaigns/new.
// useFormStatus vive dentro del <form> del padre (Server Component) y
// nos da el `pending` para deshabilitar el botón mientras la server
// action está en vuelo. Evita el doble submit.
export function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Creando…" : children}
    </button>
  );
}
