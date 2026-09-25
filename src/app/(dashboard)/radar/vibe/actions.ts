"use server";

// Estimate -> confirm -> execute for the Vibe bulk fetch (T024 refactor).
//
//   estimateFetchAction reads {icpSlug, countries, limit} de la UI,
//   resuelve los filtros API con el bloque vibeFilters del ICP
//   (linkedin_category + company_size + job_level + has_contact_details),
//   sobreescribe los países si el humano cambia el default, y llama
//   a /prospects/stats con EL MISMO filtro que enviará el fetch real
//   — así el "matches" es representativo del pool contactable, no
//   una cifra inflada por-solo-país.
//
//   executeFetchAction verifica el token contra los mismos params y
//   solo si es válido dispara el evento Inngest.
//
// Neither action touches the DB directly — writes happen in the job so
// the RLS-bypass service client stays under /jobs/**.

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { inngest } from "@/lib/inngest";
import { stats } from "@/lib/vibe/client";
import { signEstimate, verifyEstimate } from "@/lib/vibe/token";
import { resolveVibeApiFilters } from "@/lib/vibe/filters";
import { getIcpBySlug } from "@/config/icps";
import {
  VIBE_AVAILABLE_COUNTRIES,
  VIBE_DEFAULT_LIMIT,
  VIBE_MAX_CREDITS_PER_FETCH,
  VIBE_MAX_LEADS_PER_FETCH,
  estimateCredits,
} from "@/config/vibe";
import type { VibeUiFilters } from "@/lib/vibe/types";

const COUNTRY_CODES = new Set<string>(VIBE_AVAILABLE_COUNTRIES.map((c) => c.code));

function readFilters(formData: FormData): VibeUiFilters {
  const rawIcp = formData.get("icpSlug");
  const icpSlug = typeof rawIcp === "string" ? rawIcp.trim() : "";

  const countries = formData
    .getAll("countries")
    .filter((v): v is string => typeof v === "string" && COUNTRY_CODES.has(v));

  const rawLimit = formData.get("limit");
  let limit = VIBE_DEFAULT_LIMIT;
  if (typeof rawLimit === "string") {
    const n = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n >= 1) limit = Math.min(n, VIBE_MAX_LEADS_PER_FETCH);
  }

  return { icpSlug, countries, limit };
}

function buildUrlParams(filters: VibeUiFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set("icp", filters.icpSlug);
  for (const c of filters.countries) params.append("countries", c);
  params.set("limit", String(filters.limit));
  return params;
}

async function requireUser(): Promise<{ email: string; tenantId: string }> {
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
  return { email: user.email, tenantId: allowed.tenant_id };
}

export async function estimateFetchAction(formData: FormData): Promise<void> {
  const filters = readFilters(formData);
  if (filters.icpSlug === "") {
    redirect("/radar/vibe?error=no_icp");
  }
  const icp = getIcpBySlug(filters.icpSlug);
  if (!icp || !icp.vibeFilters) {
    redirect(
      `/radar/vibe?error=unknown_icp&detail=${encodeURIComponent(filters.icpSlug)}`,
    );
  }
  if (filters.countries.length === 0) {
    redirect(
      `/radar/vibe?icp=${encodeURIComponent(filters.icpSlug)}&error=no_countries`,
    );
  }

  const { email } = await requireUser();

  const apiFilters = resolveVibeApiFilters(icp, filters.countries);

  let matches: number;
  try {
    const response = await stats({ filters: apiFilters });
    matches = response.total_results;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[vibe.estimate] stats failed", detail);
    redirect(
      `/radar/vibe?icp=${encodeURIComponent(filters.icpSlug)}&error=stats&detail=${encodeURIComponent(detail)}`,
    );
  }

  const { token } = signEstimate(filters, email);
  const params = buildUrlParams(filters);
  params.set("matches", String(matches));
  params.set("token", token);
  redirect(`/radar/vibe?${params.toString()}`);
}

export async function executeFetchAction(formData: FormData): Promise<void> {
  const filters = readFilters(formData);
  if (filters.icpSlug === "") {
    redirect("/radar/vibe?error=no_icp");
  }
  const icp = getIcpBySlug(filters.icpSlug);
  if (!icp || !icp.vibeFilters) {
    redirect(
      `/radar/vibe?error=unknown_icp&detail=${encodeURIComponent(filters.icpSlug)}`,
    );
  }

  const token = formData.get("token");
  if (typeof token !== "string" || token === "") {
    redirect(
      `/radar/vibe?icp=${encodeURIComponent(filters.icpSlug)}&error=missing_token`,
    );
  }

  const { email, tenantId } = await requireUser();

  const verdict = verifyEstimate(token as string, filters, email);
  if (!verdict.valid) {
    const reason = verdict.expired ? "estimate_expired" : "estimate_invalid";
    redirect(
      `/radar/vibe?icp=${encodeURIComponent(filters.icpSlug)}&error=${reason}`,
    );
  }

  const cost = estimateCredits(filters.limit);
  const acknowledged = formData.get("acknowledge_cap") === "on";
  if (cost.total > VIBE_MAX_CREDITS_PER_FETCH && !acknowledged) {
    redirect(
      `/radar/vibe?icp=${encodeURIComponent(filters.icpSlug)}&error=cap_ack_required`,
    );
  }

  const apiFilters = resolveVibeApiFilters(icp, filters.countries);

  await inngest.send({
    name: "nova/vibe.fetch.requested",
    data: {
      tenantId,
      requestedBy: email,
      filters: {
        icpSlug: filters.icpSlug,
        countries: filters.countries,
        limit: filters.limit,
        apiFilters,
      },
      estimatedCredits: cost,
    },
  });

  redirect("/radar?vibe_started=1");
}
