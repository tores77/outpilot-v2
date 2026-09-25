// Inngest serve endpoint. Registers every job function so the Inngest
// platform can invoke them via signed webhooks.
//
// New job functions must be imported and added to `functions: [...]` below.
// Keep the list small and explicit — no dynamic discovery.

import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { healthcheck } from "@/jobs/healthcheck";
import { novaVibeFetch } from "@/jobs/nova-vibe-fetch";
import { novaScore } from "@/jobs/nova-score";
import { lexPersonalize } from "@/jobs/lex-personalize";
import { voltCreateCampaign } from "@/jobs/volt-create-campaign";
import { voltSmokePrepare } from "@/jobs/volt-smoke-prepare";
import { voltSyncLeads } from "@/jobs/volt-sync-leads";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    healthcheck,
    novaVibeFetch,
    novaScore,
    lexPersonalize,
    voltCreateCampaign,
    voltSmokePrepare,
    voltSyncLeads,
  ],
});
