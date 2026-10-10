import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path("./src"),
      "server-only": path("./tests/support/server-only-stub.ts"),
    },
  },
  test: {
    // « unit » et « sql » : règles métier et migrations sur une base locale en mémoire, sans réseau. « integration » : base Supabase de développement.
    include: process.env.TEST_SCOPE === "integration" ? ["tests/integration/**/*.test.ts"] : ["tests/unit/**/*.test.{ts,tsx}", "tests/sql/**/*.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
