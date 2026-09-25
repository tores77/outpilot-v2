import { describe, expect, it } from "vitest";
import type { IcpTemplate } from "@/config/icps";
import type { VibeApiFilters } from "@/lib/vibe/types";
import {
  defaultCountriesFromIcp,
  resolveVibeApiFilters,
} from "@/lib/vibe/filters";

function makeIcp(vibeFilters?: VibeApiFilters): IcpTemplate {
  return {
    slug: "test-icp",
    name: "Test",
    description: "d",
    channel: "email_cold",
    openerFallback: "fb",
    steps: [{ index: 1, delayDays: 0, subject: "s", bodyHtml: "<p>b</p>" }],
    vibeFilters,
  };
}

const BASE_FILTERS: VibeApiFilters = {
  company_country_code: { values: ["ES"] },
  linkedin_category: { values: ["machinery manufacturing"] },
  company_size: { values: ["11-50"] },
  job_level: { values: ["c-suite"] },
  has_contact_details: { value: "email" },
};

describe("resolveVibeApiFilters", () => {
  it("sin override devuelve los filtros del ICP tal cual (copia superficial)", () => {
    const icp = makeIcp(BASE_FILTERS);
    const out = resolveVibeApiFilters(icp);
    expect(out).toEqual(BASE_FILTERS);
    // Copia superficial: no es la misma referencia (evita mutación
    // accidental del bloque del ICP).
    expect(out).not.toBe(BASE_FILTERS);
  });

  it("con override reemplaza company_country_code sin tocar el resto", () => {
    const icp = makeIcp(BASE_FILTERS);
    const out = resolveVibeApiFilters(icp, ["PT"]);
    expect(out.company_country_code).toEqual({ values: ["PT"] });
    // El resto de filtros no cambia.
    expect(out.linkedin_category).toEqual(BASE_FILTERS.linkedin_category);
    expect(out.job_level).toEqual(BASE_FILTERS.job_level);
    expect(out.has_contact_details).toEqual(BASE_FILTERS.has_contact_details);
  });

  it("override vacío o undefined → company_country_code original sin tocar", () => {
    const icp = makeIcp(BASE_FILTERS);
    expect(resolveVibeApiFilters(icp, []).company_country_code).toEqual(
      BASE_FILTERS.company_country_code,
    );
    expect(resolveVibeApiFilters(icp).company_country_code).toEqual(
      BASE_FILTERS.company_country_code,
    );
  });

  it("override sobre un ICP sin company_country_code no inventa la clave", () => {
    const icp = makeIcp({
      linkedin_category: { values: ["retail"] },
      job_level: { values: ["director"] },
    });
    const out = resolveVibeApiFilters(icp, ["MX", "CO"]);
    expect(out.company_country_code).toBeUndefined();
    expect(out.linkedin_category).toEqual({ values: ["retail"] });
  });

  it("lanza si el ICP no declara vibeFilters", () => {
    const icp = makeIcp(undefined);
    expect(() => resolveVibeApiFilters(icp, ["ES"])).toThrow(
      /no define vibeFilters/i,
    );
  });
});

describe("defaultCountriesFromIcp", () => {
  it("devuelve los values de company_country_code cuando el ICP los declara", () => {
    expect(
      defaultCountriesFromIcp(
        makeIcp({ company_country_code: { values: ["ES"] } }),
      ),
    ).toEqual(["ES"]);
  });

  it("devuelve [] si el ICP no tiene company_country_code", () => {
    expect(
      defaultCountriesFromIcp(
        makeIcp({ linkedin_category: { values: ["retail"] } }),
      ),
    ).toEqual([]);
  });

  it("devuelve [] si el ICP no tiene vibeFilters", () => {
    expect(defaultCountriesFromIcp(makeIcp(undefined))).toEqual([]);
  });
});
