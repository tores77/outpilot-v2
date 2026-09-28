import { describe, expect, it } from "vitest";
import { CAMPAIGN_LEADS_UPSERT_ON_CONFLICT } from "@/jobs/volt-smoke-prepare";

// ============================================================
// T024 (2026-09-28): regresión del bug "no unique or exclusion
// constraint matching the ON CONFLICT specification".
//
// Estos tests NO tocan BD real — verifican dos cosas:
//   1. El string onConflict coincide EXACTAMENTE con el constraint
//      de la migration 008 (columnas + orden). Si alguien cambia
//      el string a "lead_id,campaign_id" o similar, el test falla.
//   2. El comportamiento esperado del upsert idempotente: dos
//      llamadas con el mismo par (campaign_id, lead_id) devuelven
//      1 fila en total (la primera inserta, la segunda es no-op
//      con ignoreDuplicates). Se simula con un mock stateful que
//      respeta la constraint tal como la aplicaría Postgres.
// ============================================================

describe("CAMPAIGN_LEADS_UPSERT_ON_CONFLICT (T024 regresión)", () => {
  it("coincide EXACTAMENTE con el constraint de migration 008 (orden importa)", () => {
    // Si alguien cambia el string o la migration, el test falla.
    // Documenta que el orden campaign_id, lead_id NO se puede tocar
    // sin actualizar también la constraint en Postgres.
    expect(CAMPAIGN_LEADS_UPSERT_ON_CONFLICT).toBe("campaign_id,lead_id");
  });
});

// ============================================================
// Mock stateful de supabase-js sobre campaign_leads que respeta
// una constraint UNIQUE (campaign_id, lead_id) — el mismo que
// crea la migration 008.
// ============================================================

type FakeRow = {
  id: string;
  campaign_id: string;
  lead_id: string;
  tenant_id: string;
};

function makeFakeCampaignLeadsClient() {
  const table = new Map<string, FakeRow>();
  let nextId = 1;

  function key(row: { campaign_id: string; lead_id: string }): string {
    return `${row.campaign_id}|${row.lead_id}`;
  }

  const state = {
    table,
    from(name: string) {
      if (name !== "campaign_leads") throw new Error(`unexpected table: ${name}`);
      let pendingRows: Array<{
        campaign_id: string;
        lead_id: string;
        tenant_id: string;
      }> = [];
      let pendingOnConflict = "";
      let pendingIgnoreDuplicates = false;
      const chain = {
        upsert(
          payload: Array<{ campaign_id: string; lead_id: string; tenant_id: string }>,
          opts: { onConflict?: string; ignoreDuplicates?: boolean },
        ) {
          pendingRows = payload;
          pendingOnConflict = opts.onConflict ?? "";
          pendingIgnoreDuplicates = opts.ignoreDuplicates ?? false;
          return chain;
        },
        async select(_cols: string) {
          // Simula el comportamiento de Postgres con la constraint
          // UNIQUE (campaign_id, lead_id).
          if (pendingOnConflict !== "campaign_id,lead_id") {
            // Postgres devolvería el error real del bug — el mock lo
            // reproduce para que cualquier cambio accidental del
            // onConflict rompa este test.
            return {
              data: null,
              error: {
                message:
                  "there is no unique or exclusion constraint matching the ON CONFLICT specification",
              },
            };
          }
          const inserted: Array<{ id: string }> = [];
          for (const row of pendingRows) {
            const k = key(row);
            if (table.has(k)) {
              if (pendingIgnoreDuplicates) continue;
              return {
                data: null,
                error: { message: "unique_violation" },
              };
            }
            const id = `id-${nextId++}`;
            table.set(k, { id, ...row });
            inserted.push({ id });
          }
          return { data: inserted, error: null };
        },
      };
      return chain;
    },
  };
  return state;
}

describe("campaign_leads upsert idempotente (T024 regresión bug 2026-09-28)", () => {
  it("dos upserts con el mismo (campaign_id, lead_id) → una sola fila en tabla", async () => {
    const supa = makeFakeCampaignLeadsClient();
    const row = { campaign_id: "c-1", lead_id: "l-1", tenant_id: "t-1" };

    const r1 = await supa
      .from("campaign_leads")
      .upsert([row], {
        onConflict: CAMPAIGN_LEADS_UPSERT_ON_CONFLICT,
        ignoreDuplicates: true,
      })
      .select("id");
    expect(r1.error).toBeNull();
    expect(r1.data).toHaveLength(1);

    const r2 = await supa
      .from("campaign_leads")
      .upsert([row], {
        onConflict: CAMPAIGN_LEADS_UPSERT_ON_CONFLICT,
        ignoreDuplicates: true,
      })
      .select("id");
    expect(r2.error).toBeNull();
    expect(r2.data).toHaveLength(0); // 2ª vez: nada nuevo insertado

    expect(supa.table.size).toBe(1); // solo 1 fila total
  });

  it("batch mixto: 3 leads nuevos + 2 duplicados → 3 inserts, 5 filas totales", async () => {
    const supa = makeFakeCampaignLeadsClient();
    // Pre-populate con 2 leads existentes.
    await supa
      .from("campaign_leads")
      .upsert(
        [
          { campaign_id: "c1", lead_id: "l1", tenant_id: "t1" },
          { campaign_id: "c1", lead_id: "l2", tenant_id: "t1" },
        ],
        {
          onConflict: CAMPAIGN_LEADS_UPSERT_ON_CONFLICT,
          ignoreDuplicates: true,
        },
      )
      .select("id");
    expect(supa.table.size).toBe(2);

    // Batch mixto.
    const r = await supa
      .from("campaign_leads")
      .upsert(
        [
          { campaign_id: "c1", lead_id: "l1", tenant_id: "t1" }, // dup
          { campaign_id: "c1", lead_id: "l3", tenant_id: "t1" }, // nuevo
          { campaign_id: "c1", lead_id: "l2", tenant_id: "t1" }, // dup
          { campaign_id: "c1", lead_id: "l4", tenant_id: "t1" }, // nuevo
          { campaign_id: "c1", lead_id: "l5", tenant_id: "t1" }, // nuevo
        ],
        {
          onConflict: CAMPAIGN_LEADS_UPSERT_ON_CONFLICT,
          ignoreDuplicates: true,
        },
      )
      .select("id");
    expect(r.error).toBeNull();
    expect(r.data).toHaveLength(3); // 3 nuevos
    expect(supa.table.size).toBe(5); // 2 previos + 3 nuevos
  });

  it("REGRESIÓN bug prod: onConflict con orden invertido → error de constraint", async () => {
    // Si alguien cambiara CAMPAIGN_LEADS_UPSERT_ON_CONFLICT a
    // "lead_id,campaign_id" (orden opuesto), Postgres se queja
    // porque el constraint es sobre (campaign_id, lead_id). El mock
    // reproduce el error EXACTO que apareció en producción para
    // que el test cape cualquier regresión de orden.
    const supa = makeFakeCampaignLeadsClient();
    const row = { campaign_id: "c1", lead_id: "l1", tenant_id: "t1" };
    const r = await supa
      .from("campaign_leads")
      .upsert([row], {
        onConflict: "lead_id,campaign_id", // orden invertido → mismatch
        ignoreDuplicates: true,
      })
      .select("id");
    expect(r.error?.message).toContain(
      "no unique or exclusion constraint matching the ON CONFLICT specification",
    );
  });
});
