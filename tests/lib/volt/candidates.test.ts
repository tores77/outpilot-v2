import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { selectSmokeCandidates } from "@/lib/volt/candidates";

// ============================================================
// Mock supabase acotado a las 3 tablas que consulta selectSmokeCandidates:
//   - leads: SELECT con chain de eq/gte/not/order/limit
//   - campaign_leads: SELECT lead_id con eq/is
//   - outreach_exclusions: SELECT email con eq
// ============================================================

type FakeLead = {
  id: string;
  email: string | null;
  company: string | null;
  icp_score: number | null;
  created_at: string;
  estado: string;
  needs_review: boolean;
  tenant_id: string;
};

type FakeState = {
  leads: FakeLead[];
  activeCampaignLeadIds: string[];
  exclusionEmails: string[];
  simulateExclusionsMissing?: boolean;
};

function makeMockSupabase(state: FakeState) {
  return {
    from: (table: string) => {
      if (table === "leads") {
        return leadsChain(state);
      }
      if (table === "campaign_leads") {
        return campaignLeadsChain(state);
      }
      if (table === "outreach_exclusions") {
        return exclusionsChain(state);
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

function leadsChain(state: FakeState) {
  const filters: Record<string, unknown> = {};
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters[`eq_${col}`] = val;
      return chain;
    },
    gte: (col: string, val: unknown) => {
      filters[`gte_${col}`] = val;
      return chain;
    },
    not: () => chain,
    is: () => chain,
    order: () => chain,
    limit: async (n: number) => {
      const filtered = state.leads.filter((l) => {
        if (filters.eq_tenant_id && l.tenant_id !== filters.eq_tenant_id) return false;
        if (filters.eq_estado && l.estado !== filters.eq_estado) return false;
        if (typeof filters.gte_icp_score === "number") {
          if ((l.icp_score ?? -Infinity) < (filters.gte_icp_score as number)) return false;
        }
        if (filters.eq_needs_review !== undefined && l.needs_review !== filters.eq_needs_review) {
          return false;
        }
        return true;
      });
      filtered.sort((a, b) => {
        if ((b.icp_score ?? 0) !== (a.icp_score ?? 0)) return (b.icp_score ?? 0) - (a.icp_score ?? 0);
        return a.created_at.localeCompare(b.created_at);
      });
      return { data: filtered.slice(0, n), error: null };
    },
  };
  return chain;
}

function campaignLeadsChain(state: FakeState) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: async () => ({
      data: state.activeCampaignLeadIds.map((id) => ({ lead_id: id })),
      error: null,
    }),
  };
  return chain;
}

function exclusionsChain(state: FakeState) {
  const chain = {
    select: () => chain,
    eq: async () => {
      if (state.simulateExclusionsMissing) {
        return {
          data: null,
          error: {
            message:
              'relation "outreach_exclusions" does not exist',
          },
        };
      }
      return {
        data: state.exclusionEmails.map((email) => ({ email })),
        error: null,
      };
    },
  };
  return chain;
}

// ============================================================

const TENANT = "t-1";
const BASE_ARGS = {
  tenantId: TENANT,
  minScore: 70,
  limit: 50,
  maxPerCompany: 2,
  candidatePoolSize: 500,
};

function lead(overrides: Partial<FakeLead>): FakeLead {
  // Spread merge preserva `null` explícito (nullish coalescing lo
  // convertía en el default y falseaba los tests de filtro cliente-side).
  const base: FakeLead = {
    id: "l-x",
    email: "x@example.com",
    company: "Acme",
    icp_score: 80,
    created_at: "2026-09-01T00:00:00Z",
    estado: "EN_RADAR",
    needs_review: false,
    tenant_id: TENANT,
  };
  return { ...base, ...overrides };
}

describe("selectSmokeCandidates", () => {
  it("filtro base: excluye score < min, needs_review=true, wrong estado, wrong tenant", async () => {
    const supabase = makeMockSupabase({
      leads: [
        lead({ id: "ok", icp_score: 75 }),
        lead({ id: "low_score", icp_score: 60 }), // < 70
        lead({ id: "review", needs_review: true }),
        lead({ id: "wrong_state", estado: "NUEVO" }),
        lead({ id: "other_tenant", tenant_id: "t-other" }),
      ],
      activeCampaignLeadIds: [],
      exclusionEmails: [],
    });
    const r = await selectSmokeCandidates(supabase, BASE_ARGS);
    expect(r.candidates.map((c) => c.id)).toEqual(["ok"]);
    expect(r.counts.pool_after_base_filters).toBe(1);
  });

  it("filtro cliente-side: company vacío/whitespace y email inválido fuera", async () => {
    const supabase = makeMockSupabase({
      leads: [
        lead({ id: "no_company", company: null }),
        lead({ id: "blank_company", company: "   " }),
        lead({ id: "bad_email", email: "not-an-email" }),
        lead({ id: "no_email", email: null }),
        lead({ id: "ok", email: "ana@acme.com", company: "Acme" }),
      ],
      activeCampaignLeadIds: [],
      exclusionEmails: [],
    });
    const r = await selectSmokeCandidates(supabase, BASE_ARGS);
    expect(r.candidates.map((c) => c.id)).toEqual(["ok"]);
  });

  it("excluye leads ya en campaign_leads activo (evita doble contacto)", async () => {
    const supabase = makeMockSupabase({
      leads: [
        lead({ id: "a", email: "a@x.com", company: "X" }),
        lead({ id: "b", email: "b@y.com", company: "Y" }),
      ],
      activeCampaignLeadIds: ["a"],
      exclusionEmails: [],
    });
    const r = await selectSmokeCandidates(supabase, BASE_ARGS);
    expect(r.candidates.map((c) => c.id)).toEqual(["b"]);
    expect(r.counts.excluded_by_active_campaign).toBe(1);
  });

  it("excluye emails en outreach_exclusions (case-insensitive)", async () => {
    const supabase = makeMockSupabase({
      leads: [
        lead({ id: "a", email: "Ana@Acme.COM", company: "Acme" }),
        lead({ id: "b", email: "b@y.com", company: "Y" }),
      ],
      activeCampaignLeadIds: [],
      exclusionEmails: ["ana@acme.com"],
    });
    const r = await selectSmokeCandidates(supabase, BASE_ARGS);
    expect(r.candidates.map((c) => c.id)).toEqual(["b"]);
    expect(r.counts.excluded_by_outreach_exclusions).toBe(1);
  });

  it("cap por empresa: máximo maxPerCompany por company (case-insensitive), priorizando score DESC", async () => {
    const supabase = makeMockSupabase({
      leads: [
        // Cuatro contactos de "Acme" (mismo con distintas caps de company)
        lead({ id: "acme_1", email: "a1@acme.com", company: "Acme S.L.", icp_score: 95 }),
        lead({ id: "acme_2", email: "a2@acme.com", company: "acme s.l.", icp_score: 90 }),
        lead({ id: "acme_3", email: "a3@acme.com", company: "Acme S.L.", icp_score: 85 }),
        lead({ id: "acme_4", email: "a4@acme.com", company: "Acme S.L.", icp_score: 80 }),
        // Un contacto de otra empresa
        lead({ id: "other", email: "o@other.com", company: "Other", icp_score: 78 }),
      ],
      activeCampaignLeadIds: [],
      exclusionEmails: [],
    });
    const r = await selectSmokeCandidates(supabase, { ...BASE_ARGS, maxPerCompany: 2 });
    // De Acme, solo los 2 de mayor score (95, 90). Other queda incluido.
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["acme_1", "acme_2", "other"]);
    expect(r.counts.excluded_by_company_cap).toBe(2);
  });

  it("respeta limit final y ordena globalmente por score DESC", async () => {
    const supabase = makeMockSupabase({
      leads: [
        lead({ id: "top", company: "A", email: "a@x.com", icp_score: 100 }),
        lead({ id: "mid", company: "B", email: "b@y.com", icp_score: 90 }),
        lead({ id: "bot", company: "C", email: "c@z.com", icp_score: 80 }),
      ],
      activeCampaignLeadIds: [],
      exclusionEmails: [],
    });
    const r = await selectSmokeCandidates(supabase, { ...BASE_ARGS, limit: 2 });
    expect(r.candidates.map((c) => c.id)).toEqual(["top", "mid"]);
    expect(r.counts.selected).toBe(2);
  });

  it("tie-break por created_at ASC cuando el score empata", async () => {
    const supabase = makeMockSupabase({
      leads: [
        lead({ id: "new", company: "A", email: "a@x.com", icp_score: 80, created_at: "2026-09-20T00:00:00Z" }),
        lead({ id: "old", company: "B", email: "b@y.com", icp_score: 80, created_at: "2026-09-01T00:00:00Z" }),
      ],
      activeCampaignLeadIds: [],
      exclusionEmails: [],
    });
    const r = await selectSmokeCandidates(supabase, { ...BASE_ARGS, limit: 2 });
    // Mismo score → el más antiguo primero.
    expect(r.candidates.map((c) => c.id)).toEqual(["old", "new"]);
  });

  it("outreach_exclusions no aplicada aún (relation does not exist) → silencia el error y sigue", async () => {
    const supabase = makeMockSupabase({
      leads: [lead({ id: "ok", email: "ok@example.com", company: "Acme" })],
      activeCampaignLeadIds: [],
      exclusionEmails: [],
      simulateExclusionsMissing: true,
    });
    const r = await selectSmokeCandidates(supabase, BASE_ARGS);
    expect(r.candidates).toHaveLength(1);
    expect(r.counts.excluded_by_outreach_exclusions).toBe(0);
  });

  it("counts reflejan la cascada de exclusiones", async () => {
    const supabase = makeMockSupabase({
      leads: [
        // 3 en Acme: 1 activo, 1 excluido email, 1 pasa
        lead({ id: "acme_active", email: "a@acme.com", company: "Acme", icp_score: 95 }),
        lead({ id: "acme_excluded", email: "b@acme.com", company: "Acme", icp_score: 90 }),
        lead({ id: "acme_ok_1", email: "c@acme.com", company: "Acme", icp_score: 85 }),
        // 3 más en Acme para probar cap
        lead({ id: "acme_ok_2", email: "d@acme.com", company: "Acme", icp_score: 84 }),
        lead({ id: "acme_ok_3", email: "e@acme.com", company: "Acme", icp_score: 83 }),
        // 1 en otra empresa
        lead({ id: "beta", email: "o@beta.com", company: "Beta", icp_score: 82 }),
      ],
      activeCampaignLeadIds: ["acme_active"],
      exclusionEmails: ["b@acme.com"],
    });
    const r = await selectSmokeCandidates(supabase, { ...BASE_ARGS, maxPerCompany: 2 });
    expect(r.counts.pool_after_base_filters).toBe(6);
    expect(r.counts.excluded_by_active_campaign).toBe(1);
    expect(r.counts.excluded_by_outreach_exclusions).toBe(1);
    // De Acme quedan 3 tras exclusiones (85, 84, 83), cap 2 → tira 1
    expect(r.counts.excluded_by_company_cap).toBe(1);
    // Total seleccionados: 2 de Acme + 1 de Beta
    expect(r.counts.selected).toBe(3);
  });
});
