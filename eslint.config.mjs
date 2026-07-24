import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import outpilot from "./tools/eslint/plugin.mjs";

// Patterns (not `paths`) so we catch both alias imports (@/lib/...) and
// relative imports (../../lib/...). Separate entries preserve module-specific
// messages.
const RESTRICTED_PATTERNS = [
  {
    group: ["**/lib/supabase/service"],
    message:
      "The service_role Supabase client bypasses RLS. Only import from src/jobs/**.",
  },
  {
    group: ["**/lib/ai/claude"],
    message:
      "The Claude wrapper transitively imports the service_role client. Only import from src/jobs/**.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Constitution §6 enforcement — service_role and its transitive wrapper
  // (lib/ai/claude) can only be imported from src/jobs/**. Applied to all
  // TypeScript sources except:
  //   - src/jobs/**                (jobs consume these on purpose)
  //   - src/lib/ai/claude.ts       (the wrapper is what imports service_role;
  //                                  callers of the wrapper are still gated)
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/jobs/**", "src/lib/ai/claude.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: RESTRICTED_PATTERNS },
      ],
    },
  },

  // Every Supabase query written inside src/jobs/** must include a
  // tenant_id filter. Complements the import restriction above.
  {
    files: ["src/jobs/**/*.{ts,tsx}"],
    plugins: { outpilot },
    rules: {
      "outpilot/require-tenant-id-filter": "error",
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
