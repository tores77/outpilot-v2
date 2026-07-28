"use server";

// Estimate -> confirm -> execute for the Vibe bulk fetch.
//
//   estimateFetchAction reads the UI filters, calls Vibe stats (free) with
//   the FULL server-side filter set (country + job_level + company_size +
//   linkedin_category), signs an HMAC token binding filters+email+ts,
//   and redirects to /radar/vibe?token=... so the page renders the
//   confirmation view.
//
//   executeFetchAction verifies the token against the incoming params
//   and, only if valid + not expired, enqueues the Inngest event that
//   the nova-vibe-fetch job picks up.
//
// Neither action touches the DB directly — writes happen in the job so
// the RLS-bypass service client stays under /jobs/**.

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { inngest } from "@/lib/inngest";
import { stats } from "@/lib/vibe/client";
import { signEstimate, verifyEstimate } from "@/lib/vibe/token";
import {
  VIBE_AVAILABLE_COUNTRIES,
  VIBE_AVAILABLE_SECTORS,
  VIBE_COMPANY_SIZE_VALUES,
  VIBE_DEFAULT_LIMIT,
  VIBE_DEFAULT_SENIORITY,
  VIBE_MAX_CREDITS_PER_FETCH,
  VIBE_MAX_LEADS_PER_FETCH,
  VIBE_SENIORITY_OPTIONS,
  estimateCredits,
  jobLevelsFor,
  linkedinCategoriesFor,
} from "@/config/vibe";
import type { VibeUiFilters } from "@/lib/vibe/types";

const COUNTRY_CODES = new Set<string>(VIBE_AVAILABLE_COUNTRIES.map((c) => c.code));
const SECTOR_VALUES = new Set<string>(VIBE_AVAILABLE_SECTORS);
const SENIORITY_VALUES = new Set<string>(
  VIBE_SENIORITY_OPTIONS.map((s) => s.value),
);

function readFilters(formData: FormData): VibeUiFilters {
  const countries = formData
    .getAll("countries")
    .filter((v): v is string => typeof v === "string" && COUNTRY_CODES.has(v));

  const sectors = formData
    .getAll("sectors")
    .filter((v): v is string => typeof v === "string" && SECTOR_VALUES.has(v));

  const rawSeniority = formData.get("seniority");
  const seniority =
    typeof rawSeniority === "string" && SENIORITY_VALUES.has(rawSeniority)
      ? rawSeniority
      : VIBE_DEFAULT_SENIORITY;

  const rawLimit = formData.get("limit");
  let limit = VIBE_DEFAULT_LIMIT;
  if (typeof rawLimit === "string") {
    const n = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n >= 1) limit = Math.min(n, VIBE_MAX_LEADS_PER_FETCH);
  }

  return { countries, sectors, seniority, limit };
}

function buildStatsFilters(filters: VibeUiFilters) {
  const linkedinCategories = linkedinCategoriesFor(filters.sectors);
  const jobLevels = jobLevelsFor(filters.seniority);
  const payload: {
    country_code: { values: string[] };
    job_level?: { values: string[] };
    company_size?: { values: string[] };
    linkedin_category?: { values: string[] };
  } = {
    country_code: { values: filters.countries },
    job_level: { values: jobLevels },
    company_size: { values: [...VIBE_COMPANY_SIZE_VALUES] },
  };
  if (linkedinCategories.length > 0) {
    payload.linkedin_category = { values: linkedinCategories };
  }
  return payload;
}

function buildUrlParams(filters: VibeUiFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const c of filters.countries) params.append("countries", c);
  for (const s of filters.sectors) params.append("sectors", s);
  params.set("seniority", filters.seniority);
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
  if (filters.countries.length === 0) {
    redirect("/radar/vibe?error=no_countries");
  }
  if (filters.sectors.length === 0) {
    redirect("/radar/vibe?error=no_sectors");
  }

  const { email } = await requireUser();

  let matches: number;
  try {
    const response = await stats({ filters: buildStatsFilters(filters) });
    matches = response.total_results;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[vibe.estimate] stats failed", detail);
    redirect(`/radar/vibe?error=stats&detail=${encodeURIComponent(detail)}`);
  }

  const { token } = signEstimate(filters, email);
  const params = buildUrlParams(filters);
  params.set("matches", String(matches));
  params.set("token", token);
  redirect(`/radar/vibe?${params.toString()}`);
}

export async function executeFetchAction(formData: FormData): Promise<void> {
  const filters = readFilters(formData);
  const token = formData.get("token");
  if (typeof token !== "string" || token === "") {
    redirect("/radar/vibe?error=missing_token");
  }

  const { email, tenantId } = await requireUser();

  const verdict = verifyEstimate(token as string, filters, email);
  if (!verdict.valid) {
    const reason = verdict.expired ? "estimate_expired" : "estimate_invalid";
    redirect(`/radar/vibe?error=${reason}`);
  }

  const cost = estimateCredits(filters.limit);
  const acknowledged = formData.get("acknowledge_cap") === "on";
  if (cost.total > VIBE_MAX_CREDITS_PER_FETCH && !acknowledged) {
    redirect("/radar/vibe?error=cap_ack_required");
  }

  await inngest.send({
    name: "nova/vibe.fetch.requested",
    data: {
      tenantId,
      requestedBy: email,
      filters,
      estimatedCredits: cost,
    },
  });

  redirect("/radar?vibe_started=1");
}
