// OUTPILOT v2 — Lemlist server-side client factory (T019)
// -----------------------------------------------------------------------------
// Unico punto donde LEMLIST_API_KEY entra en el bundle. `server-only`
// impide que se importe accidentalmente desde un Client Component.

import "server-only";
import { createLemlistClient, type LemlistClient } from "@/channels/lemlist/client";

export function getLemlistClient(): LemlistClient {
  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "LEMLIST_API_KEY no esta configurada. Añadela a .env.local en local o al panel de Vercel en produccion.",
    );
  }
  return createLemlistClient({ apiKey });
}
