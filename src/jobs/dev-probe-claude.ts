// Dev-only smoke probe for lib/ai/claude.ts. Not a cron, not a real feature —
// exists so we can verify end-to-end (routing, Anthropic call, api_costs
// insert) from the Inngest dashboard against the real deployment envs.
//
// Invoke from Inngest dashboard with a manual event:
//   name: "dev/probe-claude"
//   data: { "tenantId": "<uuid of the umania tenant>" }
//
// Delete once real agents (T015 onwards) exercise the wrapper naturally.
// Fase 0 · T007.

import { inngest } from "@/lib/inngest";
import { callClaude } from "@/lib/ai/claude";

type ProbeEventData = { tenantId?: unknown };

export const devProbeClaude = inngest.createFunction(
  {
    id: "dev-probe-claude",
    triggers: [{ event: "dev/probe-claude" }],
  },
  async ({ event, step }) => {
    const data = (event.data ?? {}) as ProbeEventData;
    if (typeof data.tenantId !== "string" || data.tenantId.length === 0) {
      throw new Error(
        "event.data.tenantId is required (uuid of an existing tenant).",
      );
    }
    const tenantId = data.tenantId;

    return await step.run("call-claude", () =>
      callClaude({
        task: "nova.score",
        tenantId,
        maxTokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly three words." },
        ],
      }),
    );
  },
);
