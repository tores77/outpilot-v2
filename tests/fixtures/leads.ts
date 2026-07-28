// Golden-data fixtures for Nova tests.
// Anonymised subset of the first real scoring batch (Fase 1 · T015 gate).
// The Ana / Jose pair is the anti-fabrication regression case: same
// seniority + sector, but only Jose carries verifiable company signals.

import type { LeadForScoring } from "@/lib/nova/scoring";

export const ANA_NO_SIGNAL: LeadForScoring = {
  id: "fixture-ana",
  first_name: "Ana",
  company: "Acme S.L.",
  title: "CEO",
  sector: "SaaS",
  country: "España",
  city: "Barcelona",
  // No website, no linkedin_url, no custom_fields.linkedin_category
  // The prompt gate must cap this at 69.
};

export const JOSE_WITH_SIGNALS: LeadForScoring = {
  id: "fixture-jose",
  first_name: "Jose",
  company: "Product Hackers",
  title: "CMO & Partner",
  sector: "marketing services",
  country: "España",
  website: "https://producthackers.com",
  linkedin_url: "https://linkedin.com/in/jose-example",
  custom_fields: { linkedin_category: "marketing services" },
};

export const EPSILON_INSUFFICIENT_DATA: LeadForScoring = {
  id: "fixture-epsilon",
  email: "contact@epsilon.example",
  company: "Epsilon",
  sector: "Legal",
  country: "España",
  city: "Barcelona",
  // No name, no title -> insufficient data path
};

export const CARLOS_SAME_AS_ANA: LeadForScoring = {
  id: "fixture-carlos",
  first_name: "Carlos",
  company: "Gamma",
  title: "VP Product",
  sector: "SaaS",
  country: "España",
  city: "Sevilla",
};
