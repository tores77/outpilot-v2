"use server";

// Server Action for /radar/import. T012 did raw upsert; T013 wraps it with
// the Nova cleanup pipeline:
//   1. parse CSV
//   2. map recognised columns + drop invalid emails
//   3. cleanupLeadBatch: mark generic emails as needs_review + dedupe by
//      normalised company keeping the highest-ranked title
//   4. upsert survivors with source='csv_import' and needs_review set
//
// Duplicates by (tenant_id, email) already in the database are still
// silently ignored (ignoreDuplicates=true), so re-uploading is safe.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { cleanupLeadBatch, type LeadDraft } from "@/lib/nova/cleanup";
import type { Database } from "@/lib/supabase/database.types";

type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadSource = Database["public"]["Enums"]["lead_source"];

const HEADER_ALIASES: Record<string, keyof LeadDraft> = {
  email: "email",
  "e-mail": "email",
  correo: "email",
  "first name": "first_name",
  firstname: "first_name",
  first_name: "first_name",
  nombre: "first_name",
  "last name": "last_name",
  lastname: "last_name",
  last_name: "last_name",
  apellido: "last_name",
  apellidos: "last_name",
  company: "company",
  empresa: "company",
  organization: "company",
  organización: "company",
  title: "title",
  cargo: "title",
  puesto: "title",
  position: "title",
  phone: "phone",
  telefono: "phone",
  teléfono: "phone",
  mobile: "phone",
  linkedin: "linkedin_url",
  linkedin_url: "linkedin_url",
  "linkedin url": "linkedin_url",
  website: "website",
  web: "website",
  url: "website",
  sector: "sector",
  industry: "sector",
  industria: "sector",
  country: "country",
  pais: "country",
  país: "country",
  city: "city",
  ciudad: "city",
  ciudad_provincia: "city",
};

const KNOWN_COLUMNS = new Set<keyof LeadDraft>(Object.values(HEADER_ALIASES));
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export async function importCsvAction(formData: FormData): Promise<void> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/radar/import?error=no_file");
  }

  const csvText = await file.text();

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normaliseHeader,
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    console.error("[radar.import] papaparse errors", parsed.errors.slice(0, 3));
    redirect(`/radar/import?error=parse&detail=${encodeURIComponent(first.message)}`);
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

  const tenantId = allowed.tenant_id;
  const total = parsed.data.length;
  let invalid = 0;
  const drafts: LeadDraft[] = [];

  for (const raw of parsed.data) {
    const mapped: Partial<LeadDraft> = {};
    const custom: Record<string, string> = {};

    for (const [rawKey, value] of Object.entries(raw)) {
      if (typeof value !== "string" || value.trim() === "") continue;
      const canonical = HEADER_ALIASES[rawKey];
      if (canonical) {
        (mapped as Record<string, string>)[canonical] = value.trim();
      } else {
        custom[rawKey] = value.trim();
      }
    }

    const email = mapped.email;
    if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
      invalid++;
      continue;
    }

    const draft: LeadDraft = { email };
    for (const key of KNOWN_COLUMNS) {
      if (key === "email") continue;
      if (key in mapped) {
        (draft as Record<string, unknown>)[key] = (mapped as Record<string, unknown>)[
          key
        ];
      }
    }
    if (Object.keys(custom).length > 0) {
      draft.custom_fields = custom;
    }
    drafts.push(draft);
  }

  const cleanup = cleanupLeadBatch(drafts);

  const rows: LeadInsert[] = cleanup.clean.map((clean) => ({
    tenant_id: tenantId,
    email: clean.email,
    first_name: clean.first_name ?? null,
    last_name: clean.last_name ?? null,
    company: clean.company ?? null,
    title: clean.title ?? null,
    phone: clean.phone ?? null,
    linkedin_url: clean.linkedin_url ?? null,
    website: clean.website ?? null,
    sector: clean.sector ?? null,
    country: clean.country ?? null,
    city: clean.city ?? null,
    source: "csv_import" satisfies LeadSource,
    needs_review: clean.needs_review,
    custom_fields: clean.custom_fields ?? {},
  }));

  let inserted = 0;
  if (rows.length > 0) {
    const { data, error } = await supabase
      .from("leads")
      .upsert(rows, { onConflict: "tenant_id,email", ignoreDuplicates: true })
      .select("id");
    if (error) {
      console.error("[radar.import] upsert failed", error);
      redirect(`/radar/import?error=insert&detail=${encodeURIComponent(error.message)}`);
    }
    inserted = data?.length ?? 0;
  }

  const duplicates_db = rows.length - inserted;
  const params = new URLSearchParams({
    imported: String(inserted),
    duplicates: String(duplicates_db),
    invalid: String(invalid),
    deduped: String(cleanup.stats.dropped_dedupe),
    review_count: String(cleanup.stats.marked_review),
    total: String(total),
  });

  revalidatePath("/radar");
  redirect(`/radar?${params.toString()}`);
}
