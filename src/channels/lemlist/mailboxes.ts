// OUTPILOT v2 — Lemlist mailboxes helper (T019)
// -----------------------------------------------------------------------------
// Consulta los mailboxes de una cuenta de Lemlist. En Lemlist un mailbox
// pertenece a un user; hay que iterar userIds del /team y leer cada
// /users/:id para aplanar los arrays `mailboxes`.
//
// Solo lectura. No forma parte de la interfaz ChannelProvider (canal
// no lo abstrae, por ahora).

import type { LemlistClient } from "./client";

/**
 * Shape del user tal y como devuelve GET /api/users/:id. Solo los
 * campos que consumimos aqui; el resto se ignora.
 */
type LemlistUserWithMailboxes = {
  _id: string;
  email?: string;
  mailboxes?: Array<{
    _id?: string;
    email?: string;
    provider?: string;
    status?: string;
    lemlist?: { emailLimit?: number };
    lemwarm?: { active?: boolean };
  }>;
};

type LemlistTeam = {
  _id?: string;
  userIds?: string[];
};

/**
 * Resumen minimo de mailbox para la UI de settings. Todo lo que no
 * llega del provider queda `null` — la UI decide como mostrarlo. El
 * `healthScore` es null hasta que Sage (T035) lo calcule.
 */
export type MailboxSummary = {
  externalId: string; // usm_...
  email: string;
  provider: string; // 'google' | 'outlook' | ...
  status: string; // 'OK' | 'paused' | ...
  emailLimit: number;
  warmupActive: boolean;
  healthScore: number | null; // placeholder hasta T035
};

/**
 * Fetch de todos los mailboxes visibles con la API key actual. Falla
 * si alguna de las llamadas subyacentes lanza — el caller (page de
 * settings) captura y decide como presentar el error al usuario.
 */
export async function fetchAllMailboxes(
  client: LemlistClient,
): Promise<MailboxSummary[]> {
  const team = await client.get<LemlistTeam>("/team");
  const userIds = Array.isArray(team?.userIds) ? team.userIds : [];
  if (userIds.length === 0) return [];

  const users = await Promise.all(
    userIds.map((id) =>
      client.get<LemlistUserWithMailboxes>(`/users/${encodeURIComponent(id)}`),
    ),
  );

  const summaries: MailboxSummary[] = [];
  for (const user of users) {
    const boxes = Array.isArray(user?.mailboxes) ? user.mailboxes : [];
    for (const box of boxes) {
      if (!box || typeof box._id !== "string" || typeof box.email !== "string") {
        continue;
      }
      summaries.push({
        externalId: box._id,
        email: box.email,
        provider: typeof box.provider === "string" ? box.provider : "unknown",
        status: typeof box.status === "string" ? box.status : "unknown",
        emailLimit:
          typeof box.lemlist?.emailLimit === "number"
            ? box.lemlist.emailLimit
            : 0,
        warmupActive:
          typeof box.lemwarm?.active === "boolean" ? box.lemwarm.active : false,
        healthScore: null,
      });
    }
  }
  return summaries;
}
