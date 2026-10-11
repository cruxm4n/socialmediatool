import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { configureIsolatedTests, loadLocalEnv } from "./tests/support/env";

/*
 * Tests de bout en bout : ils pilotent l'application compilée dans un vrai navigateur,
 * avec la base Supabase de développement et un Buffer SIMULÉ (aucun appel à Buffer).
 * Chaque série utilise un identifiant unique : elle repart de publications neuves.
 */
loadLocalEnv();
configureIsolatedTests();
process.env.MOCK_RUN_ID ??= `e2e-${Date.now()}`;
// Création de comptes depuis l'interface : clé d'administration des comptes de la PILE DE TEST (jamais une autre) et
// clé de chiffrement jetable, générée pour cette série.
if (process.env.TEST_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SERVICE_ROLE_KEY;
process.env.CADENCE_CREDENTIALS_KEY ??= randomBytes(32).toString("base64");

const PORT = 3100;
// E2E_BASE_URL : application déjà démarrée (image Docker, serveur lancé sous une autre version de Node) ; aucun serveur
// n'est alors construit ni lancé par Playwright. Sa configuration (Buffer simulé, MOCK_RUN_ID, secrets de test) doit
// être celle de cette série.
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  // Les tests partagent une même base : ils s'exécutent l'un après l'autre.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } }],
  webServer: external ? undefined : {
    command: `npm run build && npx next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/connexion`,
    reuseExistingServer: false,
    timeout: 240_000,
    // URGENT_LOOP=off : les parcours pilotent eux-mêmes la synchronisation et la compensation (déterminisme des captures).
    // Build de production + Buffer simulé : autorisé EXPLICITEMENT (sans CADENCE_ALLOW_SIMULATED_BUFFER, la
    // version de production refuse tout fournisseur simulé).
    env: { ISOLATED_BUILD: "1", BUFFER_MODE: "mock", CADENCE_ALLOW_SIMULATED_BUFFER: "1", MOCK_RUN_ID: process.env.MOCK_RUN_ID, URGENT_LOOP: "off" },
  },
});
