// Volt — crear campaña en Lemlist (T023).
//
// Evento: `volt/campaign.create.requested` con { tenantId, campaignId,
// requestedBy }. Manual (botón "Crear en Lemlist" por campaña en
// /campaigns).
//
// UN RECURSO LEMLIST POR STEP DE INNGEST (regla del gate T023):
//   1. load-campaign            — lee BD (name, sequence, external_id)
//   2. create-lemlist-campaign  — POST /campaigns (skip si already synced)
//   3. persist-external-id      — UPDATE BD (guard IS NULL)
//   4. load-existing-schedules  — GET /campaigns/:cid/schedules
//   5. patch-default-schedule   — PATCH default → window 1 (M-X-J 09-11)
//   6. ensure-window-2-schedule — POST /schedules + POST associate
//                                  (skip cada uno si ya existe / asociado)
//   7. upload-sequence-step-{i} — un step.run por step del sequence
//                                  (skip si ya existe en la posición i;
//                                  aborta con "divergent" si el existente
//                                  tiene otro subject)
//   8. record-event
//
// Cada step reintentable sin duplicar recursos externos.
//
// NO se ejecuta start/launch en Lemlist. La campaña queda en `draft`
// tras la creación. La transición a "smoke_test"/"active" es T024.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { createLemlistClient } from "@/channels/lemlist/client";
import {
  addSequenceStep,
  associateSchedule,
  createLemlistCampaign,
  createSchedule,
  findScheduleMatching,
  getCampaignSchedules,
  getCampaignSequences,
  patchLemlistCampaign,
  patchSchedule,
  type LemlistScheduleBody,
} from "@/channels/lemlist/campaign-ops";
import {
  VOLT_ACTIVE_DAYS_PER_WEEK,
  VOLT_DEFAULT_SCHEDULES,
} from "@/config/lemlist";
import { VOLT_DISABLE_OPEN_TRACKING } from "@/config/volt";
import {
  composeAddStepBody,
  describeStep,
  stepMatches,
} from "@/lib/volt/step-mapper";
import type { Database } from "@/lib/supabase/database.types";

type EventData = {
  tenantId?: unknown;
  campaignId?: unknown;
  requestedBy?: unknown;
};

function parseEventData(raw: unknown): {
  tenantId: string;
  campaignId: string;
  requestedBy: string;
} {
  const data = (raw ?? {}) as EventData;
  return {
    tenantId: typeof data.tenantId === "string" ? data.tenantId : "",
    campaignId: typeof data.campaignId === "string" ? data.campaignId : "",
    requestedBy:
      typeof data.requestedBy === "string" ? data.requestedBy : "volt",
  };
}

type CampaignRow = Database["public"]["Tables"]["campaigns"]["Row"];

type SequenceStep = {
  index: number;
  delayDays: number;
  // subject opcional en steps 2+ (reply-thread behavior). Ver
  // src/lib/volt/step-mapper.ts para la lógica de composición.
  subject?: string;
  bodyHtml: string;
};

function extractSequence(campaign: CampaignRow): {
  steps: SequenceStep[];
} {
  const seq = campaign.sequence as unknown;
  if (!seq || typeof seq !== "object") {
    throw new Error(
      `volt-create-campaign: campaign ${campaign.id} sin sequence válido`,
    );
  }
  const rawSteps = (seq as { steps?: unknown }).steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(
      `volt-create-campaign: sequence.steps vacío para campaign ${campaign.id}`,
    );
  }
  return {
    steps: rawSteps.map((s, i) => {
      const step = s as Record<string, unknown>;
      const idx = typeof step.index === "number" ? step.index : i + 1;
      const delay = typeof step.delayDays === "number" ? step.delayDays : 0;
      // subject opcional: si viene undefined o cadena vacía tras trim,
      // NO se fija (el mapper luego omite la clave al enviar a Lemlist).
      const rawSubj = typeof step.subject === "string" ? step.subject : "";
      const subj = rawSubj.trim() === "" ? undefined : rawSubj;
      const body = typeof step.bodyHtml === "string" ? step.bodyHtml : "";
      return { index: idx, delayDays: delay, subject: subj, bodyHtml: body };
    }),
  };
}

function getLemlistClient() {
  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("volt-create-campaign: LEMLIST_API_KEY no está configurada");
  }
  return createLemlistClient({ apiKey });
}

export const voltCreateCampaign = inngest.createFunction(
  {
    id: "volt-create-campaign",
    triggers: [{ event: "volt/campaign.create.requested" }],
    // Serializa por campaignId — dos clicks al mismo botón (o
    // create-campaign + sync-leads en paralelo) se procesan uno detrás
    // de otro; nunca en paralelo sobre la misma campaña.
    concurrency: [{ limit: 1, key: "event.data.campaignId" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { tenantId, campaignId, requestedBy } = parseEventData(event.data);
    if (!tenantId) throw new Error("volt-create-campaign: missing tenantId");
    if (!campaignId) throw new Error("volt-create-campaign: missing campaignId");

    const supabase = createSupabaseServiceClient();
    const lemlist = getLemlistClient();

    // ===== 1. Load campaign =====
    const campaign = await step.run("load-campaign", async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", campaignId)
        .maybeSingle();
      if (error) throw new Error(`load-campaign failed: ${error.message}`);
      if (!data) throw new Error(`campaign ${campaignId} not found for tenant`);
      return data;
    });

    const { steps: sequenceSteps } = extractSequence(campaign);

    // ===== 2. Create Lemlist campaign (skip if already synced) =====
    const externalId = await step.run("create-lemlist-campaign", async () => {
      if (campaign.provider_external_id) return campaign.provider_external_id;
      const created = await createLemlistCampaign(lemlist, {
        name: campaign.name,
      });
      return created._id;
    });

    // ===== 3. Persist external_id (guard IS NULL) =====
    await step.run("persist-external-id", async () => {
      if (campaign.provider_external_id === externalId) return { updated: 0 };
      const { data, error } = await supabase
        .from("campaigns")
        .update({ provider_external_id: externalId })
        .eq("tenant_id", tenantId)
        .eq("id", campaignId)
        .is("provider_external_id", null)
        .select("id");
      if (error) throw new Error(`persist-external-id failed: ${error.message}`);
      return { updated: (data ?? []).length };
    });

    // ===== 3b. Disable open tracking (T024 — Apple MPP + Gmail
    //           invalidan el píxel; sin señal accionable, mejor
    //           liberar el HTML del pixel). Idempotente: PATCH con
    //           partial update aplicado N veces = mismo estado.
    if (VOLT_DISABLE_OPEN_TRACKING) {
      await step.run("disable-open-tracking", () =>
        patchLemlistCampaign(lemlist, externalId, {
          tracking: { trackOpens: false },
        }),
      );
    }

    // ===== 4. Load existing schedules =====
    const existingSchedules = await step.run("load-existing-schedules", () =>
      getCampaignSchedules(lemlist, externalId),
    );

    if (existingSchedules.length === 0) {
      throw new Error(
        `volt-create-campaign: campaign ${externalId} no tiene Default schedule auto-creado; contrato roto`,
      );
    }
    const defaultScheduleId = existingSchedules[0]._id;
    const [window1, window2] =
      VOLT_DEFAULT_SCHEDULES as readonly LemlistScheduleBody[];

    // ===== 5. PATCH default → window 1 (M-X-J 09-11 Madrid) =====
    // PATCH es naturalmente idempotente: mismo body N veces = mismo resultado.
    await step.run("patch-default-schedule", () =>
      patchSchedule(lemlist, defaultScheduleId, window1),
    );

    // ===== 6. Ensure window 2 (POST + associate si no existe) =====
    // Refresh de schedules tras el PATCH (no strictly needed pero
    // consistente con el chequeo idempotencia).
    const window2Result = await step.run("ensure-window-2-schedule", async () => {
      const current = await getCampaignSchedules(lemlist, externalId);
      const existingWin2 = findScheduleMatching(current, window2);
      if (existingWin2) {
        return { scheduleId: existingWin2, created: false, associated: false };
      }
      const newSched = await createSchedule(lemlist, window2);
      await associateSchedule(lemlist, externalId, newSched._id);
      return { scheduleId: newSched._id, created: true, associated: true };
    });

    // ===== 7. Upload sequence steps (un step.run por step) =====
    // Idempotencia via stepMatches (src/lib/volt/step-mapper.ts):
    //   - GET sequences fresco por step (memoizable si el step.run pasa).
    //   - Si posición i tiene un step que MATCHES el expected → skip.
    //     Match: ambos con subject → subjects iguales; ambos sin
    //     subject (reply-thread) → message[:80] iguales.
    //   - Si tiene otro (divergent) → abort con detalle.
    //   - Si vacía → POST con body compuesto por composeAddStepBody
    //     (que OMITE la clave subject cuando está vacía; enviar "" NO
    //     dispara el reply-thread behavior de Lemlist).
    let stepsCreated = 0;
    let stepsSkipped = 0;
    for (let i = 0; i < sequenceSteps.length; i += 1) {
      const expected = sequenceSteps[i];
      const outcome = await step.run(`upload-step-${i}`, async () => {
        const seqMap = await getCampaignSequences(lemlist, externalId);
        const sequenceIds = Object.keys(seqMap);
        if (sequenceIds.length === 0) {
          throw new Error(
            `upload-step-${i}: campaign ${externalId} no expone sequence en GET /sequences`,
          );
        }
        const sequenceId = sequenceIds[0];
        const currentSteps = seqMap[sequenceId]?.steps ?? [];
        const atPosition = currentSteps[i];
        if (atPosition) {
          if (stepMatches(atPosition, expected)) {
            return { action: "skip", stepId: atPosition._id ?? null };
          }
          throw new Error(
            `upload-step-${i}: DIVERGENT SEQUENCE en posición ${i}. Expected: ${describeStep(expected)}. Actual: ${describeStep(atPosition)}. Limpieza manual necesaria antes de re-triggerear.`,
          );
        }
        const body = composeAddStepBody(expected);
        const created = await addSequenceStep(lemlist, sequenceId, body);
        return { action: "create", stepId: created._id };
      });
      if (outcome.action === "create") stepsCreated += 1;
      else stepsSkipped += 1;
    }

    const latencyMs = Date.now() - startedAt;

    // ===== 8. record-event =====
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: tenantId,
        kind: "volt.create_campaign",
        actor: requestedBy,
        entity_type: "campaign",
        entity_id: campaignId,
        payload: {
          provider_external_id: externalId,
          previously_synced: !!campaign.provider_external_id,
          default_schedule_id: defaultScheduleId,
          window_2_schedule_id: window2Result.scheduleId,
          window_2_created: window2Result.created,
          window_2_associated: window2Result.associated,
          sequence_steps_total: sequenceSteps.length,
          sequence_steps_created: stepsCreated,
          sequence_steps_skipped: stepsSkipped,
          active_days_per_week: VOLT_ACTIVE_DAYS_PER_WEEK,
          latency_ms: latencyMs,
        },
      });
      if (error) console.error("[volt-create-campaign] events insert failed", error);
    });

    return {
      provider_external_id: externalId,
      previously_synced: !!campaign.provider_external_id,
      window_2: window2Result,
      steps_created: stepsCreated,
      steps_skipped: stepsSkipped,
      latency_ms: latencyMs,
    };
  },
);
