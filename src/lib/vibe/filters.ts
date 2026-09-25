// Vibe API filter resolver (T024).
//
// Un ICP define su bloque `vibeFilters` con la taxonomía y umbrales
// exactos que la API entiende. La UI de /radar/vibe deja al humano
// sobreescribir los países (para expandir un ICP ES a PT, etc.) pero
// no toca el resto (linkedin_category, company_size, job_level,
// has_contact_details son de casa por ICP).
//
// Este helper aplica el override de países SOLO sobre las claves que
// el ICP ya declara (no inventa filtros que el ICP no incluyó). Así
// un ICP que solo filtra por `prospect_country_code` no acaba de
// pronto con `company_country_code` sobreescrito.

import type { IcpTemplate } from "@/config/icps";
import type { VibeApiFilters } from "./types";

export function resolveVibeApiFilters(
  icp: IcpTemplate,
  countryOverrides?: readonly string[],
): VibeApiFilters {
  const base = icp.vibeFilters;
  if (!base) {
    throw new Error(
      `resolveVibeApiFilters: ICP '${icp.slug}' no define vibeFilters`,
    );
  }
  const resolved: VibeApiFilters = { ...base };
  if (
    countryOverrides &&
    countryOverrides.length > 0 &&
    base.company_country_code
  ) {
    resolved.company_country_code = { values: [...countryOverrides] };
  }
  return resolved;
}

/**
 * Devuelve los códigos de país declarados por el ICP (defaults para
 * el pre-fill del form).
 */
export function defaultCountriesFromIcp(icp: IcpTemplate): readonly string[] {
  return icp.vibeFilters?.company_country_code?.values ?? [];
}
