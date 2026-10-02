"use server";

// Server actions de /inbox (T025 bloque E):
//   - labelReplyAction: pone replies.label + labeled_by='human' +
//     labeled_at. RLS garantiza que solo el tenant del usuario toca
//     sus propias filas.
//
// Etiquetas aceptadas (según pedido Pere): interesado, no_ahora,
// no_interesado, fuera_de_icp, baja. Allowlist estricta para no
// aceptar valores arbitrarios desde el form.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { INBOX_LABELS, type InboxLabel } from "./labels";

export async function labelReplyAction(formData: FormData): Promise<void> {
  const replyIdRaw = formData.get("reply_id");
  const labelRaw = formData.get("label");

  const replyId =
    typeof replyIdRaw === "string" && /^[0-9a-f-]{36}$/i.test(replyIdRaw)
      ? replyIdRaw
      : null;
  const label =
    typeof labelRaw === "string" && (INBOX_LABELS as readonly string[]).includes(labelRaw)
      ? (labelRaw as InboxLabel)
      : null;

  if (!replyId) redirect("/inbox?error=bad_reply_id");
  if (!label) redirect("/inbox?error=bad_label");

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  // RLS tenant-isolation protege de cross-tenant; además el UPDATE
  // solo pasa si la fila existe para el tenant del caller.
  const { error } = await supabase
    .from("replies")
    .update({
      label,
      labeled_by: "human",
      labeled_at: new Date().toISOString(),
    })
    .eq("id", replyId!);
  if (error) {
    redirect(`/inbox?error=${encodeURIComponent(error.message.slice(0, 80))}`);
  }

  revalidatePath("/inbox");
}
