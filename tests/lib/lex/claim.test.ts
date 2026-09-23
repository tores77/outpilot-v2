import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  claimPendingLeads,
  countPending,
  finalizePersonalization,
  sweepStaleClaims,
} from "@/lib/lex/claim";

// ============================================================
// Mock supabase que simula estado compartido atómico.
// El SELECT devuelve la fila si personalization === null.
// El UPDATE sobre .is("personalization", null) muta atómicamente:
// si la fila sigue null, sobreescribe; si otro update ya escribió
// (mismo microtask tick), devuelve []. Bajo Node single-thread el
// orden es determinista (FIFO en la microtask queue).
// ============================================================

type FakeLead = {
  id: string;
  first_name: string;
  email: string;
  website: string | null;
};

function makeAtomicMock(state: {
  personalization: unknown;
  rowId: string;
  lead: FakeLead;
}) {
  const supabase = {
    from: (_table: string) => {
      const selectChain: {
        select: (cols?: string) => typeof selectChain;
        eq: (...args: unknown[]) => typeof selectChain;
        is: (...args: unknown[]) => typeof selectChain;
        in: (...args: unknown[]) => typeof selectChain;
        order: (...args: unknown[]) => typeof selectChain;
        limit: (n: number) => Promise<{ data: unknown; error: null }>;
        update: (payload: { personalization: unknown }) => unknown;
      } = {
        select: () => selectChain,
        eq: () => selectChain,
        is: () => selectChain,
        in: () => selectChain,
        order: () => selectChain,
        limit: async () => ({
          data: state.personalization === null ? [{ id: state.rowId }] : [],
          error: null,
        }),
        update: (payload) => {
          // Fase 2 del claim: UPDATE atómico + SELECT del row completo.
          const updateChain = {
            eq: () => updateChain,
            in: () => updateChain,
            is: () => updateChain,
            select: () => ({
              // Thenable: cuando el caller await, ejecutamos el check
              // atómico. Ejecución síncrona dentro del `then` garantiza
              // que dos calls concurrentes ordenen por FIFO en la
              // microtask queue.
              then: (
                onResolve: (result: { data: unknown; error: null }) => void,
              ) => {
                if (state.personalization === null) {
                  state.personalization = payload.personalization;
                  onResolve({
                    data: [{ id: state.rowId, lead: state.lead }],
                    error: null,
                  });
                } else {
                  onResolve({ data: [], error: null });
                }
              },
            }),
          };
          return updateChain;
        },
      };
      return selectChain;
    },
  };
  return supabase as unknown as SupabaseClient<Database>;
}

const FAKE_LEAD: FakeLead = {
  id: "lead-1",
  first_name: "Alice",
  email: "alice@example.com",
  website: null,
};

describe("claimPendingLeads", () => {
  it("reclama la fila si personalization=null y devuelve claim_started_at", async () => {
    const supabase = makeAtomicMock({
      personalization: null,
      rowId: "cl-1",
      lead: FAKE_LEAD,
    });
    const claimed = await claimPendingLeads(supabase, {
      tenantId: "t-1",
      campaignId: "c-1",
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].campaign_lead_id).toBe("cl-1");
    expect(claimed[0].lead).toEqual(FAKE_LEAD);
    // ISO timestamp
    expect(claimed[0].claim_started_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("devuelve [] si la fila ya está reclamada (personalization != null)", async () => {
    const supabase = makeAtomicMock({
      personalization: { state: "processing", started_at: "2026-09-23T12:00:00.000Z" },
      rowId: "cl-1",
      lead: FAKE_LEAD,
    });
    const claimed = await claimPendingLeads(supabase, {
      tenantId: "t-1",
      campaignId: "c-1",
      limit: 10,
    });
    expect(claimed).toHaveLength(0);
  });

  it("RACE: dos claims concurrentes sobre 1 lead → total reclamado = 1", async () => {
    // El corazón del test post-mortem del fan-out. Bajo Node
    // single-thread, ambas invocaciones ven la fila null en su SELECT
    // (Fase 1); en la Fase 2 (UPDATE), la primera muta el estado
    // atómicamente y la segunda ve el estado ya cambiado → 0 filas
    // reclamadas → 0 llamadas a Haiku sobre ese lead en el segundo run.
    const shared = {
      personalization: null as unknown,
      rowId: "cl-1",
      lead: FAKE_LEAD,
    };
    const supabase = makeAtomicMock(shared);

    const [c1, c2] = await Promise.all([
      claimPendingLeads(supabase, {
        tenantId: "t-1",
        campaignId: "c-1",
        limit: 10,
      }),
      claimPendingLeads(supabase, {
        tenantId: "t-1",
        campaignId: "c-1",
        limit: 10,
      }),
    ]);

    // Total reclamado exacto = 1. Uno gana, el otro pierde.
    expect(c1.length + c2.length).toBe(1);
    // El estado compartido refleja el claim ganador.
    expect(shared.personalization).toMatchObject({ state: "processing" });
  });
});

// ============================================================
// Tests unitarios auxiliares: helpers son pure enough para verificar
// que solo llaman a lo que dicen. Los tests exhaustivos de queries
// concretas quedan cubiertos por el smoke end-to-end en producción.
// ============================================================

describe("finalizePersonalization", () => {
  it("devuelve true si el UPDATE afectó al menos una fila", async () => {
    const capturedFilters: Array<{ op: string; args: unknown[] }> = [];
    const supabase = {
      from: () => {
        const chain: {
          update: () => typeof chain;
          eq: (...args: unknown[]) => typeof chain;
          select: () => Promise<{ data: unknown[]; error: null }>;
        } = {
          update: () => chain,
          eq: (...args: unknown[]) => {
            capturedFilters.push({ op: "eq", args });
            return chain;
          },
          select: async () => ({ data: [{ id: "cl-1" }], error: null }),
        };
        return chain;
      },
    } as unknown as SupabaseClient<Database>;

    const ok = await finalizePersonalization(supabase, {
      tenantId: "t-1",
      campaignLeadId: "cl-1",
      claimStartedAt: "2026-09-23T12:00:00.000Z",
      payload: { version: 1, opener: "x", personalization: "personalized" },
    });

    expect(ok).toBe(true);
    // Guarda que se aplicaron ambos guards.
    const eqCols = capturedFilters.map((f) => f.args[0]);
    expect(eqCols).toContain("personalization->>state");
    expect(eqCols).toContain("personalization->>started_at");
  });

  it("devuelve false si el UPDATE no afectó filas (lost race)", async () => {
    const supabase = {
      from: () => {
        const chain: {
          update: () => typeof chain;
          eq: () => typeof chain;
          select: () => Promise<{ data: unknown[]; error: null }>;
        } = {
          update: () => chain,
          eq: () => chain,
          select: async () => ({ data: [], error: null }),
        };
        return chain;
      },
    } as unknown as SupabaseClient<Database>;

    const ok = await finalizePersonalization(supabase, {
      tenantId: "t-1",
      campaignLeadId: "cl-1",
      claimStartedAt: "2026-09-23T12:00:00.000Z",
      payload: {},
    });
    expect(ok).toBe(false);
  });
});

describe("countPending", () => {
  it("clasifica NULL, processing_active y processing_stale correctamente", async () => {
    const staleMs = 10 * 60 * 1000; // 10 min
    const nowMs = Date.now();
    const staleTime = new Date(nowMs - staleMs - 1000).toISOString();
    const freshTime = new Date(nowMs - 1000).toISOString();
    const finalDone = {
      version: 1,
      opener: "x",
      personalization: "personalized",
    };

    const rows = [
      { personalization: null },
      { personalization: null },
      { personalization: { state: "processing", started_at: staleTime } },
      { personalization: { state: "processing", started_at: freshTime } },
      { personalization: finalDone }, // no cuenta
    ];

    const supabase = {
      from: () => {
        const chain: {
          select: () => typeof chain;
          eq: () => typeof chain;
          is: () => Promise<{ data: typeof rows; error: null }>;
        } = {
          select: () => chain,
          eq: () => chain,
          is: async () => ({ data: rows, error: null }),
        };
        return chain;
      },
    } as unknown as SupabaseClient<Database>;

    const counts = await countPending(supabase, {
      tenantId: "t-1",
      campaignId: "c-1",
      staleMs,
    });
    // activePending = 2 null + 1 stale = 3
    expect(counts.activePending).toBe(3);
    // activeProcessing = 1 fresh
    expect(counts.activeProcessing).toBe(1);
    // El "done" no aparece en ningún contador.
  });
});

describe("sweepStaleClaims", () => {
  it("no toca nada si no hay filas processing stale", async () => {
    const rows = [
      { id: "a", personalization: null },
      { id: "b", personalization: { version: 1, personalization: "generic" } },
    ];
    const supabase = {
      from: () => {
        const chain: {
          select: () => typeof chain;
          eq: () => typeof chain;
          is: () => Promise<{ data: typeof rows; error: null }>;
        } = {
          select: () => chain,
          eq: () => chain,
          is: async () => ({ data: rows, error: null }),
        };
        return chain;
      },
    } as unknown as SupabaseClient<Database>;
    const swept = await sweepStaleClaims(supabase, {
      tenantId: "t-1",
      campaignId: "c-1",
      staleMs: 10_000,
    });
    expect(swept).toBe(0);
  });
});
