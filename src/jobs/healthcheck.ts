// Hourly cron that proves the Inngest pipeline is reaching this deployment.
// Fase 0 · T006.
//
// For now it only logs. When migration 006 lands in T008 (events table) this
// handler will also insert a row so the Daily Brief (Sage, T035) can flag
// missed hours. The log line is the interim signal.

import { inngest } from "@/lib/inngest";

export const healthcheck = inngest.createFunction(
  {
    id: "healthcheck",
    triggers: [{ cron: "0 * * * *" }],
  },
  async () => {
    const ts = new Date().toISOString();
    console.log("[inngest] healthcheck ok", { ts });
    return { ok: true, ts };
  },
);
