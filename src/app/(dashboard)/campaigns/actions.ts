"use server";

// Server actions de /campaigns (lista):
//   - personalizeCampaignAction (T022): encola Lex.
//   - createLemlistCampaignAction (T023): encola volt-create-campaign.
//   - syncLeadsToLemlistAction (T023): encola volt-sync-leads.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { inngest } from "@/lib/inngest";

export async function personalizeCampaignAction(
  formData: FormData,
): Promise<void> {
  const campaignId = formData.get("campaign_id");
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    redirect("/campaigns?error=no_campaign_id");
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

  // Verifica que la campaña pertenece al tenant (RLS también lo haría,
  // pero un select explícito nos evita encolar un job que fallará al
  // no encontrar filas).
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("tenant_id", allowed.tenant_id)
    .eq("id", campaignId as string)
    .maybeSingle();
  if (!campaign) {
    redirect("/campaigns?error=campaign_not_found");
  }

  await inngest.send({
    name: "lex/personalize.requested",
    data: {
      tenantId: allowed.tenant_id,
      campaignId: campaignId as string,
      requestedBy: user.email,
    },
  });

  revalidatePath("/campaigns");
  redirect(
    `/campaigns?personalization_started=${encodeURIComponent(campaignId as string)}`,
  );
}

// Volt: crear campaña en Lemlist + subir schedules + sequence steps
// (T023). No añade leads; eso es syncLeadsToLemlistAction.
export async function createLemlistCampaignAction(
  formData: FormData,
): Promise<void> {
  const campaignId = formData.get("campaign_id");
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    redirect("/campaigns?error=no_campaign_id");
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

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("tenant_id", allowed.tenant_id)
    .eq("id", campaignId as string)
    .maybeSingle();
  if (!campaign) redirect("/campaigns?error=campaign_not_found");

  await inngest.send({
    name: "volt/campaign.create.requested",
    data: {
      tenantId: allowed.tenant_id,
      campaignId: campaignId as string,
      requestedBy: user.email,
    },
  });

  revalidatePath("/campaigns");
  redirect(
    `/campaigns?volt_create_started=${encodeURIComponent(campaignId as string)}`,
  );
}

// Volt: subir leads a Lemlist. Requiere que la campaña esté creada
// (provider_external_id ≠ null). El botón solo aparece cuando lo está.
export async function syncLeadsToLemlistAction(
  formData: FormData,
): Promise<void> {
  const campaignId = formData.get("campaign_id");
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    redirect("/campaigns?error=no_campaign_id");
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

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, provider_external_id")
    .eq("tenant_id", allowed.tenant_id)
    .eq("id", campaignId as string)
    .maybeSingle();
  if (!campaign) redirect("/campaigns?error=campaign_not_found");
  if (!campaign.provider_external_id) {
    redirect(
      `/campaigns?error=not_created_in_lemlist&campaign_id=${encodeURIComponent(campaignId as string)}`,
    );
  }

  await inngest.send({
    name: "volt/leads.sync.requested",
    data: {
      tenantId: allowed.tenant_id,
      campaignId: campaignId as string,
      requestedBy: user.email,
    },
  });

  revalidatePath("/campaigns");
  redirect(
    `/campaigns?volt_sync_started=${encodeURIComponent(campaignId as string)}`,
  );
}
