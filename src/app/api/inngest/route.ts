// Inngest serve endpoint. Registers every job function so the Inngest
// platform can invoke them via signed webhooks.
//
// New job functions must be imported and added to `functions: [...]` below.
// Keep the list small and explicit — no dynamic discovery.

import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { healthcheck } from "@/jobs/healthcheck";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [healthcheck],
});
