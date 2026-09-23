"use server";

// Server action de T021 (builder de secuencias). Recibe FormData del
// formulario /campaigns/new, valida con Zod (variables permitidas y
// shape del sequence), resuelve el tenant del usuario autenticado e
// inserta la campaña en `draft`. No sincroniza con Lemlist (eso es
// T023).

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getIcpBySlug } from "@/config/icps";
import { sequenceSchema, type Sequence } from "@/lib/campaigns/sequence";
import type { Database } from "@/lib/supabase/database.types";

type CampaignInsert = Database["public"]["Tables"]["campaigns"]["Insert"];

function fieldString(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

function fieldInt(fd: FormData, key: string): number {
  const raw = fieldString(fd, key).trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : NaN;
}

export async function createCampaignAction(formData: FormData): Promise<void> {
  const name = fieldString(formData, "name").trim();
  const templateSlug = fieldString(formData, "templateSlug").trim();

  if (name.length === 0) {
    redirect(
      `/campaigns/new?icp=${encodeURIComponent(templateSlug)}&error=no_name`,
    );
  }

  const template = getIcpBySlug(templateSlug);
  if (!template) {
    redirect("/campaigns/new?error=unknown_icp");
  }

  // Reconstruir sequence desde los inputs. Cada step del template
  // tiene una fila; leemos los N indices y componemos el array.
  const stepsInput: Sequence["steps"] = template.steps.map((_, i) => ({
    index: fieldInt(formData, `step-${i}-index`),
    delayDays: fieldInt(formData, `step-${i}-delayDays`),
    subject: fieldString(formData, `step-${i}-subject`),
    bodyHtml: fieldString(formData, `step-${i}-bodyHtml`),
  }));

  const candidate: Sequence = {
    version: 1,
    templateSlug,
    steps: stepsInput,
  };

  const parsed = sequenceSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = first
      ? `${first.path.join(".")}: ${first.message}`
      : "Sequence invalida.";
    redirect(
      `/campaigns/new?icp=${encodeURIComponent(templateSlug)}&error=validation&detail=${encodeURIComponent(detail)}`,
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  const { data: allowed } = await supabase
    .from("allowed_users")
    .select("tenant_id")
    .eq("email", user.email)
    .maybeSingle();
  if (!allowed) redirect("/login?error=access_denied");

  // Red de seguridad contra doble submit (el botón client ya se
  // deshabilita, pero un segundo enter en teclado antes de que Next
  // marque el pending podría colarse). RLS ya filtra por tenant, pero
  // acotamos explícito.
  const { data: existing } = await supabase
    .from("campaigns")
    .select("id")
    .eq("tenant_id", allowed.tenant_id)
    .eq("name", name)
    .eq("status", "draft")
    .limit(1)
    .maybeSingle();
  if (existing) {
    redirect(
      `/campaigns/new?icp=${encodeURIComponent(templateSlug)}&error=duplicate_name`,
    );
  }

  const insert: CampaignInsert = {
    tenant_id: allowed.tenant_id,
    name,
    status: "draft",
    channel: "email",
    provider: "lemlist",
    icp_slug: template.slug,
    sequence: parsed.data,
  };

  const { data: created, error } = await supabase
    .from("campaigns")
    .insert(insert)
    .select("id")
    .single();

  if (error || !created) {
    console.error("[campaigns.create] insert failed", error);
    redirect(
      `/campaigns/new?icp=${encodeURIComponent(templateSlug)}&error=insert&detail=${encodeURIComponent(error?.message ?? "unknown")}`,
    );
  }

  revalidatePath("/campaigns");
  redirect(`/campaigns?created=${created.id}`);
}
