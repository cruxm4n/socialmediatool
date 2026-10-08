import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { requireEnv } from "../support/env";

export type DemoUser = "ADMIN" | "INES" | "HUGO" | "SOFIA";

export const authFile = (user: DemoUser) => `tests/.auth/${user.toLowerCase()}.json`;

/** Identifiant Buffer simulé d'une publication de démonstration, propre à cette série de tests. */
export const bufferId = (key: string) => `mock-${requireEnv("MOCK_RUN_ID")}-${key}`;

export const postLink = (page: Page, key: string) => page.locator(`[data-post="${bufferId(key)}"]`);

const automationHeaders = () => ({ "x-automation-secret": requireEnv("AUTOMATION_SECRET") });

/** Lance une synchronisation comme le ferait un planificateur. */
export async function syncViaApi(request: APIRequestContext) {
  const response = await request.post("/api/automation/sync", { headers: automationHeaders() });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

/** Agit sur le Buffer simulé, comme si l'on modifiait le post à la main dans Buffer. */
export async function mockBuffer(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/api/automation/mock", { headers: automationHeaders(), data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

export async function login(page: Page, user: DemoUser) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(requireEnv(`DEMO_${user}_EMAIL`));
  await page.getByLabel("Mot de passe").fill(requireEnv(`DEMO_${user}_PASSWORD`));
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/connexion"));
}

/** Ouvre une publication depuis la liste « À valider » du client. */
export async function openPending(page: Page, orgSlug: string, key: string) {
  await page.goto(`/client/${orgSlug}/a-valider`);
  await postLink(page, key).click();
  await expect(page.getByText("Cette proposition attend votre décision")).toBeVisible();
}

export async function approve(page: Page) {
  await page.getByRole("button", { name: "Approuver" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmer l'approbation" }).click();
}
