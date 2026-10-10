import { expect, test } from "@playwright/test";

import { requireEnv } from "../support/env";

/*
 * (Mission V3) Contrôles HTTP du processus de service : traitement urgent, préparation au service, protections par
 * secret. Aucun état n'est modifié (aucun travail urgent n'est en attente à la fin de la série).
 */
const secret = () => ({ "x-automation-secret": requireEnv("AUTOMATION_SECRET") });

test("le traitement urgent exige le secret d'automatisation", async ({ request }) => {
  expect((await request.post("/api/automation/urgent")).status()).toBe(401);
  expect((await request.post("/api/automation/urgent", { headers: { "x-automation-secret": "faux" } })).status()).toBe(401);
});

test("le traitement urgent répond sans rien faire quand rien n'est en attente (aucune requête Buffer inutile)", async ({ request }) => {
  const response = await request.post("/api/automation/urgent", { headers: secret() });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.compensationFailures).toBe(0);
});

test("la préparation au service : refusée sans secret, prête avec lui, sans fuite de configuration", async ({ request }) => {
  const denied = await request.get("/api/ready");
  expect(denied.status()).toBe(401);
  expect(await denied.text()).not.toMatch(/migration|supabase/i);

  const ready = await request.get("/api/ready", { headers: secret() });
  expect(ready.status(), await ready.text()).toBe(200);
  const body = await ready.json();
  expect(body.ready).toBe(true);
  const dump = JSON.stringify(body);
  expect(dump).not.toContain(requireEnv("AUTOMATION_SECRET"));
  expect(dump).not.toMatch(/https?:\/\//);
});

test("la liveness ne dépend d'aucune configuration ni d'aucun secret", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect((await response.json()).ok).toBe(true);
});
