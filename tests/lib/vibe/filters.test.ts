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
  prospect_country_code: { values: ["ES"] },
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

  it("con override aplica los países SOLO a las claves que el ICP declara", () => {
    const icp = makeIcp(BASE_FILTERS);
    const out = resolveVibeApiFilters(icp, ["PT"]);
    expect(out.company_country_code).toEqual({ values: ["PT"] });
    expect(out.prospect_country_code).toEqual({ values: ["PT"] });
    // El ICP no tiene country_code (usa company/prospect por separado):
    // el override NO inventa esa clave.
    expect(out.country_code).toBeUndefined();
    // El resto de filtros no cambia.
    expect(out.linkedin_category).toEqual(BASE_FILTERS.linkedin_category);
    expect(out.job_level).toEqual(BASE_FILTERS.job_level);
    expect(out.has_contact_details).toEqual(BASE_FILTERS.has_contact_details);
  });

  it("override vacío o undefined → filtros originales sin tocar países", () => {
    const icp = makeIcp(BASE_FILTERS);
    expect(resolveVibeApiFilters(icp, []).company_country_code).toEqual(
      BASE_FILTERS.company_country_code,
    );
    expect(resolveVibeApiFilters(icp).company_country_code).toEqual(
      BASE_FILTERS.company_country_code,
    );
  });

  it("override sobre un ICP que solo tiene country_code (legacy) sobreescribe solo esa clave", () => {
    const icp = makeIcp({
      country_code: { values: ["ES"] },
      job_level: { values: ["director"] },
    });
    const out = resolveVibeApiFilters(icp, ["MX", "CO"]);
    expect(out.country_code).toEqual({ values: ["MX", "CO"] });
    expect(out.company_country_code).toBeUndefined();
    expect(out.prospect_country_code).toBeUndefined();
  });

  it("lanza si el ICP no declara vibeFilters", () => {
    const icp = makeIcp(undefined);
    expect(() => resolveVibeApiFilters(icp, ["ES"])).toThrow(
      /no define vibeFilters/i,
    );
  });
});

describe("defaultCountriesFromIcp", () => {
  it("prioridad prospect_country_code > company_country_code > country_code", () => {
    expect(
      defaultCountriesFromIcp(
        makeIcp({
          prospect_country_code: { values: ["ES"] },
          company_country_code: { values: ["MX"] },
          country_code: { values: ["PT"] },
        }),
      ),
    ).toEqual(["ES"]);
    expect(
      defaultCountriesFromIcp(
        makeIcp({
          company_country_code: { values: ["MX"] },
          country_code: { values: ["PT"] },
        }),
      ),
    ).toEqual(["MX"]);
    expect(
      defaultCountriesFromIcp(
        makeIcp({
          country_code: { values: ["PT"] },
        }),
      ),
    ).toEqual(["PT"]);
  });

  it("devuelve [] si el ICP no tiene vibeFilters", () => {
    expect(defaultCountriesFromIcp(makeIcp(undefined))).toEqual([]);
  });
});
