// OUTPILOT v2 — Fixtures anonimizados de Lemlist
// Fase 2 · T018
//
// Shapes derivados de respuestas reales de la API (probes de T018)
// pero con todos los datos reemplazados por placeholders. Ningun _id,
// email, dominio, subject o body proviene de la cuenta real de Umania.

// ===== Activities (webhook events) =====

export const lemlistActivitySent = {
  _id: "act_FIXTURE_sent_001",
  type: "emailsSent",
  createdAt: "2026-09-20T10:15:00.000Z",
  campaignId: "cam_FIXTURE_campaign",
  sequenceId: "seq_FIXTURE_sequence",
  sequenceStep: 0,
  stepId: "stp_FIXTURE_step0",
  leadId: "lea_FIXTURE_lead_001",
  sendUserMailboxId: "usm_FIXTURE_mailbox_a",
  // PII (deberia strippearse):
  leadEmail: "target@example.com",
  leadFirstName: "Alice",
  leadLastName: "Example",
  leadCompanyName: "Example Corp",
  companyDomain: "example.com",
  linkedinUrl: "https://linkedin.com/in/example",
  email: "target@example.com",
  firstName: "Alice",
  lastName: "Example",
} as const;

export const lemlistActivityOpened = {
  _id: "act_FIXTURE_opened_001",
  type: "emailsOpened",
  createdAt: "2026-09-20T10:45:00.000Z",
  campaignId: "cam_FIXTURE_campaign",
  sequenceStep: 0,
  leadId: "lea_FIXTURE_lead_001",
  sendUserMailboxId: "usm_FIXTURE_mailbox_a",
  leadEmail: "target@example.com",
  leadFirstName: "Alice",
} as const;

export const lemlistActivityClicked = {
  _id: "act_FIXTURE_clicked_001",
  type: "emailsClicked",
  createdAt: "2026-09-20T10:50:00.000Z",
  leadId: "lea_FIXTURE_lead_001",
  sendUserMailboxId: "usm_FIXTURE_mailbox_a",
  leadEmail: "target@example.com",
  clickedUrl: "https://example-cta.test/reservar",
} as const;

export const lemlistActivityBounced = {
  _id: "act_FIXTURE_bounced_001",
  type: "emailsBounced",
  createdAt: "2026-09-20T10:20:00.000Z",
  leadId: "lea_FIXTURE_lead_002",
  sendUserMailboxId: "usm_FIXTURE_mailbox_b",
  leadEmail: "invalid@example.com",
  reason: "hard_bounce",
} as const;

export const lemlistActivityReplied = {
  _id: "act_FIXTURE_replied_001",
  type: "emailsReplied",
  createdAt: "2026-09-20T11:15:00.000Z",
  leadId: "lea_FIXTURE_lead_001",
  sendUserMailboxId: "usm_FIXTURE_mailbox_a",
  leadEmail: "target@example.com",
  leadFirstName: "Alice",
  leadLastName: "Example",
  subject: "Re: Fixture subject",
  body: "<p>Fixture reply body. Interested, please share pricing.</p>",
  text: "Fixture reply body. Interested, please share pricing.",
} as const;

export const lemlistActivityUnsubscribed = {
  _id: "act_FIXTURE_unsub_001",
  type: "emailsUnsubscribed",
  createdAt: "2026-09-20T12:00:00.000Z",
  leadId: "lea_FIXTURE_lead_003",
  sendUserMailboxId: "usm_FIXTURE_mailbox_a",
  leadEmail: "optout@example.com",
} as const;

export const lemlistActivityFailed = {
  _id: "act_FIXTURE_failed_001",
  type: "emailsFailed",
  createdAt: "2026-09-20T12:30:00.000Z",
  leadId: "lea_FIXTURE_lead_004",
  sendUserMailboxId: "usm_FIXTURE_mailbox_b",
  leadEmail: "failed@example.com",
  reason: "smtp_error",
} as const;

export const lemlistActivityInterested = {
  _id: "act_FIXTURE_interested_001",
  type: "emailsInterested",
  createdAt: "2026-09-20T11:20:00.000Z",
  leadId: "lea_FIXTURE_lead_001",
  leadEmail: "target@example.com",
} as const;

// ===== Sequence shape (derivado de /campaigns/:id/sequences) =====

export const lemlistSequenceFixture = {
  seq_FIXTURE_sequence: {
    _id: "seq_FIXTURE_sequence",
    steps: [
      {
        _id: "stp_FIXTURE_step0",
        delay: 0,
        emailTemplateId: "etp_FIXTURE_template_a",
        index: 1,
        sequenceId: "seq_FIXTURE_sequence",
        sequenceStep: 0,
        subject: "{{firstName}}, fixture subject about {{companyName}}",
        message: "<p>Fixture body with {{firstName}} and {{companyName}}.</p>",
        type: "email",
      },
      {
        _id: "stp_FIXTURE_step1",
        delay: 4,
        emailTemplateId: "etp_FIXTURE_template_b",
        index: 2,
        sequenceId: "seq_FIXTURE_sequence",
        sequenceStep: 1,
        subject: "Fixture follow-up subject",
        message: "<p>Fixture follow-up body.</p>",
        type: "email",
      },
    ],
  },
} as const;

// ===== User + mailboxes (derivado de /users/:id) =====

export const lemlistUserFixture = {
  _id: "usr_FIXTURE_user",
  email: "operator@example.com",
  role: "admin",
  mailboxes: [
    {
      _id: "usm_FIXTURE_mailbox_a",
      email: "sender-a@example.com",
      provider: "google",
      status: "OK",
      lemlist: { emailLimit: 30 },
      lemwarm: { active: true },
    },
    {
      _id: "usm_FIXTURE_mailbox_b",
      email: "sender-b@example.com",
      provider: "google",
      status: "OK",
      lemlist: { emailLimit: 30 },
      lemwarm: { active: true },
    },
  ],
} as const;
