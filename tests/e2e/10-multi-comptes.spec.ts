import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { requireEnv } from "../support/env";
import { authFile, automationHeaders, mockBuffer, syncViaApi } from "./helpers";

/*
 * Deux clients, deux comptes Buffer SYNTHÉTIQUES distincts, de bout en bout dans un vrai navigateur.
 * Les deux comptes sont des comptes simulés isolés (aucun appel à Buffer, aucune clé réelle) : ce parcours prouve le
 * comportement de Cadence, pas celui de Buffer. Demande les migrations 0012 et 0013 sur la base de test.
 *
 *  1-2. l'administrateur crée le client A et le client B, et donne accès à leur utilisateur ;
 *  3.   il configure une connexion par client ;
 *  4.   il attribue à chacun les canaux de SON compte (et ne peut pas les donner à l'autre) ;
 *  5-6. chaque compte apporte ses publications à valider ;
 *  7-8. chaque client ne voit que les siennes, approuve ou demande une modification ;
 *  9.   les approbations sont programmées, chacune dans SON compte ;
 *  10-11. le compte A devient injoignable : B continue de fonctionner ;
 *  12-13. A est de nouveau joignable : sa programmation en attente est faite, une seule fois ;
 *  14.  la connexion de B est révoquée (demandée, puis définitive) ;
 *  15.  aucune action croisée n'est possible.
 */

const stamp = Date.now();
const NAME = { A: `Atelier Alpha ${stamp}`, B: `Brasserie Bravo ${stamp}` };
const client: Record<"A" | "B", { id: string; slug: string; account: string }> = { A: { id: "", slug: "", account: "" }, B: { id: "", slug: "", account: "" } };
const USER = { A: "INES", B: "SOFIA" } as const;
const run = () => requireEnv("MOCK_RUN_ID");
const postId = (who: "A" | "B", key: "bienvenue-li" | "bienvenue-ig") => `mock-${run()}-${client[who].account}-${key}`;
const channelId = (who: "A" | "B", service: "linkedin" | "instagram") => `mock-ch-${client[who].account}-${service}`;
const admin = async (browser: import("@playwright/test").Browser) => (await browser.newContext({ storageState: authFile("ADMIN") })).newPage();
const as = async (browser: import("@playwright/test").Browser, who: "A" | "B") => (await browser.newContext({ storageState: authFile(USER[who]) })).newPage();
const statusOf = async (request: APIRequestContext, who: "A" | "B", key: "bienvenue-li" | "bienvenue-ig") =>
  ((await mockBuffer(request, { action: "stats", account: client[who].account, key })) as { post: { status: string } | null; scheduleCalls: number });
const card = (page: Page, label: string) => page.locator("[data-connection]").filter({ hasText: label });

async function assign(page: Page, bufferChannelId: string, organizationName: string) {
  const row = page.locator(`[data-channel="${bufferChannelId}"]`);
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: new RegExp(organizationName) }).click();
}

test.describe.serial("deux clients, deux comptes Buffer synthétiques", () => {
  test("1-3. deux clients créés, un utilisateur chacun, une connexion Buffer par client", async ({ browser }) => {
    const page = await admin(browser);
    for (const who of ["A", "B"] as const) {
      await page.goto("/admin/clients");
      await page.getByRole("button", { name: "Nouveau client" }).click();
      await page.getByLabel("Nom", { exact: true }).fill(NAME[who]);
      await page.getByLabel("Secteur d'activité").fill("Essais multi-comptes");
      await page.getByRole("button", { name: "Créer le client" }).click();
      await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]{36}$/);
      client[who].id = page.url().split("/").pop()!;

      // Sans compte Buffer : c'est dit, et rien n'est inventé.
      await expect(page.getByTestId("aucun-compte-buffer")).toContainText("Aucun compte Buffer connecté");

      await page.getByLabel("Donner accès à un nouveau compte").fill(requireEnv(`DEMO_${USER[who]}_EMAIL`));
      await page.getByRole("button", { name: "Donner accès" }).click();
      await expect(page.getByText(requireEnv(`DEMO_${USER[who]}_EMAIL`))).toBeVisible();

      await page.getByRole("button", { name: "Ajouter une connexion Buffer" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Nom de la connexion").fill(`Buffer de ${NAME[who]}`);
      await dialog.getByRole("button", { name: "Créer la connexion" }).click();
      await expect(card(page, `Buffer de ${NAME[who]}`)).toContainText("Jamais lue");
      await expect(card(page, `Buffer de ${NAME[who]}`)).toContainText("Simulé");
    }
    await page.goto("/admin/clients");
    for (const who of ["A", "B"] as const) {
      client[who].slug = (await page.getByRole("link", { name: new RegExp(NAME[who]) }).getAttribute("data-org"))!;
      expect(client[who].slug).toBeTruthy();
    }
  });

  test("4. chaque compte apporte ses canaux ; ils ne s'attribuent qu'au client de LEUR compte", async ({ browser, request }) => {
    await syncViaApi(request);
    const page = await admin(browser);
    for (const who of ["A", "B"] as const) {
      await page.goto(`/admin/clients/${client[who].id}`);
      const connection = card(page, `Buffer de ${NAME[who]}`);
      await expect(connection).toContainText("2 canaux");
      await connection.getByRole("button", { name: "Détails" }).click();
      const detail = connection.getByTestId("detail-connexion");
      await expect(detail).toContainText("Réseaux sociaux connectés (2)");
      client[who].account = (await detail.innerText()).match(/Compte simulé (c[0-9a-f]{10})/)![1];
    }
    expect(client.A.account).not.toBe(client.B.account);

    await page.goto("/admin/clients");
    // Tentative croisée : le canal du compte de A ne peut pas être donné au client B.
    await assign(page, channelId("A", "linkedin"), NAME.B);
    await expect(page.getByText("Ce canal vient du compte Buffer d'un autre client")).toBeVisible();
    for (const who of ["A", "B"] as const) {
      for (const service of ["linkedin", "instagram"] as const) {
        await page.goto("/admin/clients");
        await assign(page, channelId(who, service), NAME[who]);
        await expect(page.locator(`[data-channel="${channelId(who, service)}"]`).getByRole("combobox")).toContainText(NAME[who]);
      }
    }
  });

  test("5-8. chaque client ne voit que les publications de SON compte ; A approuve, B approuve l'une et demande une modification de l'autre", async ({ browser, request }) => {
    await syncViaApi(request);
    const pages = { A: await as(browser, "A"), B: await as(browser, "B") };
    for (const who of ["A", "B"] as const) {
      const other = who === "A" ? "B" : "A";
      const page = pages[who];
      await page.goto(`/client/${client[who].slug}/a-valider`);
      await expect(page.locator(`[data-post="${postId(who, "bienvenue-li")}"]`)).toBeVisible();
      await expect(page.locator(`[data-post="${postId(who, "bienvenue-ig")}"]`)).toBeVisible();
      await expect(page.locator(`[data-post="${postId(other, "bienvenue-li")}"]`)).toHaveCount(0);
      // L'espace de l'autre client n'existe pas pour lui.
      const foreign = await page.goto(`/client/${client[other].slug}/a-valider`);
      expect(foreign?.status()).toBe(404);
    }

    // 7-9. Approbation : la publication est programmée dans le compte Buffer DU CLIENT, et dans aucun autre.
    for (const who of ["A", "B"] as const) {
      const page = pages[who];
      await page.goto(`/client/${client[who].slug}/a-valider`);
      await page.locator(`[data-post="${postId(who, "bienvenue-li")}"]`).click();
      await page.getByRole("button", { name: "Approuver" }).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirmer l'approbation" }).click();
      await expect(page.getByText("Publication approuvée et programmée dans Buffer.")).toBeVisible();
    }
    for (const who of ["A", "B"] as const) {
      expect((await statusOf(request, who, "bienvenue-li")).post?.status).toBe("scheduled");
      // Une seule programmation par compte : celle de sa propre publication.
      expect((await statusOf(request, who, "bienvenue-li")).scheduleCalls).toBe(1);
    }
    // Les synchronisations ne reprogramment rien.
    await syncViaApi(request);
    for (const who of ["A", "B"] as const) {
      expect((await statusOf(request, who, "bienvenue-li")).post?.status).toBe("scheduled");
      expect((await statusOf(request, who, "bienvenue-li")).scheduleCalls).toBe(1);
    }

    // 8. B demande une modification de sa seconde publication : rien n'est programmé pour elle.
    await pages.B.goto(`/client/${client.B.slug}/a-valider`);
    await pages.B.locator(`[data-post="${postId("B", "bienvenue-ig")}"]`).click();
    await pages.B.getByRole("button", { name: "Demander des modifications" }).click();
    await pages.B.getByRole("dialog").getByLabel("Votre demande").fill("Merci de changer le visuel.");
    await pages.B.getByRole("dialog").getByRole("button", { name: /Envoyer/ }).click();
    await expect(pages.B.getByText(/modification/i).first()).toBeVisible();
    expect((await statusOf(request, "B", "bienvenue-ig")).post?.status).toBe("draft");
  });

  test("10-11. le compte A devient injoignable : l'accord de A est enregistré mais sa programmation échoue et le dit ; le compte B reste sain", async ({ browser, request }) => {
    await mockBuffer(request, { action: "setUnavailable", account: client.A.account, unavailable: true });
    const page = await as(browser, "A");
    await page.goto(`/client/${client.A.slug}/a-valider`);
    await page.locator(`[data-post="${postId("A", "bienvenue-ig")}"]`).click();
    await page.getByRole("button", { name: "Approuver" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirmer l'approbation" }).click();
    // L'accord est enregistré ; la programmation n'a pas pu se faire et n'est jamais annoncée comme faite.
    await expect(page.getByText("La programmation dans Buffer n'a pas abouti")).toBeVisible();
    await expect(page.getByText("Publication approuvée et programmée dans Buffer.")).toHaveCount(0);
    // Une seule programmation a jamais atteint le compte A : celle de sa première publication, avant la panne.
    expect((await statusOf(request, "A", "bienvenue-ig")).scheduleCalls).toBe(1);

    const response = await request.post("/api/automation/sync", { headers: automationHeaders() });
    const sync = await response.json();
    // La panne du compte A est signalée ; rien n'a pu être programmé pour lui, et rien n'a été écrit chez B.
    expect(sync.scheduled, JSON.stringify(sync)).toBe(0);
    expect(JSON.stringify(sync)).toContain("non lu");
    expect((await statusOf(request, "A", "bienvenue-ig")).scheduleCalls).toBe(1);
    const adminPage = await admin(browser);
    await adminPage.goto("/admin/parametres");
    await expect(card(adminPage, `Buffer de ${NAME.A}`)).toContainText("En erreur");
    await expect(card(adminPage, `Buffer de ${NAME.B}`)).toContainText("Simulation active");
    // Rien de A n'a été retiré ni déclaré absent pendant sa panne.
    await page.goto(`/client/${client.A.slug}/publications`);
    await expect(page.locator(`[data-post="${postId("A", "bienvenue-li")}"]`)).toBeVisible();
    expect((await statusOf(request, "B", "bienvenue-li")).post?.status).toBe("scheduled");
    expect((await statusOf(request, "B", "bienvenue-li")).scheduleCalls).toBe(1);
  });

  test("12-13. le compte A est de nouveau joignable : sa publication approuvée pendant la panne est programmée à la synchronisation, une seule fois, dans SON compte", async ({ browser, request }) => {
    await mockBuffer(request, { action: "setUnavailable", account: client.A.account, unavailable: false });
    await syncViaApi(request);
    const after = await statusOf(request, "A", "bienvenue-ig");
    expect(after.post?.status).toBe("scheduled");
    // Deux programmations dans le compte A (ses deux publications approuvées), toujours une seule dans le compte B.
    expect(after.scheduleCalls).toBe(2);
    expect((await statusOf(request, "B", "bienvenue-li")).scheduleCalls).toBe(1);
    await syncViaApi(request);
    expect((await statusOf(request, "A", "bienvenue-ig")).scheduleCalls).toBe(2);
    const page = await admin(browser);
    await page.goto("/admin/parametres");
    await expect(card(page, `Buffer de ${NAME.A}`)).toContainText("Simulation active");
  });

  test("14. révocation du compte de B : d'abord demandée (une publication y est programmée), puis définitive sur décision explicite ; A n'est pas touché", async ({ browser, request }) => {
    const page = await admin(browser);
    await page.goto(`/admin/clients/${client.B.id}`);
    const connection = card(page, `Buffer de ${NAME.B}`);
    await connection.getByRole("button", { name: "Détails" }).click();
    await expect(connection.getByTestId("detail-connexion")).toContainText("Programmations en attente (1)");
    await connection.getByRole("button", { name: "Révoquer" }).click();
    await page.getByRole("button", { name: "Révoquer la connexion" }).click();
    await expect(page.getByText(/Révocation demandée : \d+ publication\(s\) de ce compte sont encore programmées dans Buffer/)).toBeVisible();
    await expect(connection).toContainText("Révocation demandée");
    await expect(connection).toHaveAttribute("data-status", "revoking");

    // Décision explicite : la phrase de confirmation est exigée, et le message dit ce qui reste à faire dans Buffer.
    await connection.getByRole("button", { name: "Révoquer quand même" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Rien ne change dans Buffer");
    await dialog.getByRole("textbox").fill("révoquer");
    await dialog.getByRole("button", { name: "Révoquer quand même" }).click();
    await expect(page.getByText(/Connexion révoquée : sa clé est effacée\. Les publications encore programmées/)).toBeVisible();
    await expect(connection).toHaveAttribute("data-status", "revoked");

    // Le compte de A continue de fonctionner ; les publications de B restent visibles, rien n'est déclaré retiré.
    const sync = await syncViaApi(request);
    expect(sync.ok).toBe(true);
    expect((await statusOf(request, "A", "bienvenue-li")).post?.status).toBe("scheduled");
    expect((await statusOf(request, "B", "bienvenue-li")).post?.status).toBe("scheduled");
    const clientB = await as(browser, "B");
    await clientB.goto(`/client/${client.B.slug}/publications`);
    await expect(clientB.locator(`[data-post="${postId("B", "bienvenue-li")}"]`)).toBeVisible();
  });

  test("15. aucune action croisée : un client n'atteint ni les réglages, ni l'autre client, ni ses publications", async ({ browser }) => {
    const page = await as(browser, "A");
    await page.goto("/admin/parametres");
    await expect(page).toHaveURL(/\/client\//);
    await page.goto(`/admin/clients/${client.B.id}`);
    await expect(page).toHaveURL(/\/client\//);
    await page.goto(`/client/${client.A.slug}/publications`);
    const html = await page.content();
    expect(html).not.toContain(client.B.account);
    expect(html).not.toContain(NAME.B);
    // Mobile : la fiche du client et ses connexions tiennent dans l'écran.
    const mobile = await (await browser.newContext({ storageState: authFile("ADMIN"), viewport: { width: 390, height: 844 } })).newPage();
    await mobile.goto(`/admin/clients/${client.A.id}`);
    await expect(card(mobile, `Buffer de ${NAME.A}`)).toBeVisible();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mobile.goto("/admin/parametres");
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
