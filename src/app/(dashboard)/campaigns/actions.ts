"use server";

// Server actions de /campaigns (lista). Por ahora solo
// personalizeCampaignAction (T022).

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
