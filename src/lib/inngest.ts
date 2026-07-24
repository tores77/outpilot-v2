// Inngest client shared by every job and by the serve endpoint. Event/signing
// keys are read from INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY automatically.
//
// This file is safe to import from anywhere (Server Components, Route
// Handlers, jobs). The service_role Supabase client is NOT imported here —
// that stays under /jobs/**.

import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "outpilot-v2",
});
