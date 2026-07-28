"use server";

// Server Action for /radar/import. Parses a CSV of leads, inserts new
// rows with source='csv_import' and estado defaulting to 'NUEVO'. This
// is the *raw import*: T013 will add the cleanup pipeline (dedupe by
// company/title hierarchy, generic-email REVIEW flag, accent
// normalisation) either before this insert or as a post-processing pass.
//
// Duplicates by (tenant_id, email) are silently ignored (upsert with
// ignoreDuplicates=true) so re-uploading a CSV is safe.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadSource = Database["public"]["Enums"]["lead_source"];

// Header aliases -> canonical column. Match is case-insensitive and ignores
// spaces / underscores / hyphens.
const HEADER_ALIASES: Record<string, keyof LeadInsert> = {
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

const KNOWN_COLUMNS = new Set(Object.values(HEADER_ALIASES));
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
  const rows: LeadInsert[] = [];

  for (const raw of parsed.data) {
    const mapped: Record<string, unknown> = {};
    const custom: Record<string, string> = {};

    for (const [rawKey, value] of Object.entries(raw)) {
      if (typeof value !== "string" || value.trim() === "") continue;
      const canonical = HEADER_ALIASES[rawKey];
      if (canonical) {
        mapped[canonical] = value.trim();
      } else {
        custom[rawKey] = value.trim();
      }
    }

    const email = mapped.email;
    if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
      invalid++;
      continue;
    }

    const row: LeadInsert = {
      tenant_id: tenantId,
      email,
      source: "csv_import" satisfies LeadSource,
    };
    for (const key of KNOWN_COLUMNS) {
      if (key === "email") continue;
      if (key in mapped) {
        // TS: mapped values are strings; the corresponding columns accept text|null.
        (row as Record<string, unknown>)[key] = mapped[key];
      }
    }
    if (Object.keys(custom).length > 0) {
      row.custom_fields = custom;
    }
    rows.push(row);
  }

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

  const duplicates = rows.length - inserted;

  revalidatePath("/radar");
  redirect(
    `/radar?imported=${inserted}&duplicates=${duplicates}&invalid=${invalid}&total=${total}`,
  );
}
