import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    // Vitest isolates workers per file by default; keep it explicit so
    // fixtures cannot leak state across tests.
    isolate: true,
    reporters: ["default"],
  },
});
