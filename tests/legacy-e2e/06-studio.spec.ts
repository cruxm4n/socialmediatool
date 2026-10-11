import { expect, test } from "@playwright/test";

import { authFile, mockBuffer, syncViaApi } from "../e2e/helpers";

/*
 * Content Studio, de la rédaction à l'approbation. Demande la migration 0008 sur la base de test.
 * Buffer simulé : aucun brouillon n'est créé dans le vrai Buffer, rien n'est publié.
 * NON EXÉCUTÉ tant qu'aucune base de test dédiée n'existe (voir TESTING.md).
 */

const title = `Essai Studio ${Date.now()}`;
const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

test.describe.serial("content studio", () => {
  test("l'administrateur rédige un contenu : sauvegarde automatique, texte par réseau, contrôles", async ({ browser }) => {
    const page = await (await browser.newContext({ storageState: authFile("ADMIN") })).newPage();
    await page.goto("/admin/studio/nouveau");
    await page.getByRole("link", { name: /^Maison Colibri/ }).click();
    await expect(page).toHaveURL(/\/admin\/studio\/nouveau\?client=/);

    await page.getByLabel("Titre interne").fill(title);
    await expect(page.getByTestId("checks")).toContainText("Choisissez au moins un canal.");
    await page.getByText("Maison Colibri", { exact: true }).last().click();
    await page.getByLabel(/^Texte pour/).fill("Le Guji est de retour.");
    await page.getByLabel("Ajouter des hashtags").fill("café, lyon");
    await page.getByLabel("Ajouter des hashtags").press("Enter");
    await expect(page.getByTestId("hashtags")).toContainText("#café");
    await page.getByLabel("Jour").fill(inTenDays);

    // La sauvegarde automatique crée le contenu et l'adresse le suit.
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-status", "saved");
    await expect(page.getByTestId("studio-preview")).toContainText("Le Guji est de retour.");
    await expect(page.getByTestId("checks")).toContainText("Prêt à être envoyé en validation.");

    // Le contenu créé se retrouve dans la liste du Studio, rien n'est perdu.
    await page.goto("/admin/studio");
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await expect(page.getByLabel("Titre interne")).toHaveValue(title);
    await expect(page.getByLabel(/^Texte pour/)).toHaveValue("Le Guji est de retour.");
  });

  test("le contenu figure au calendrier comme brouillon, avant tout envoi à Buffer", async ({ browser, request }) => {
    const page = await (await browser.newContext({ storageState: authFile("ADMIN") })).newPage();
    const before = (await mockBuffer(request, { action: "stats", key: "guji-li" })).scheduleCalls;
    await page.goto("/admin/calendrier");
    await expect(page.locator('[data-movable="true"]').filter({ hasText: title }).first()).toBeVisible();
    expect((await mockBuffer(request, { action: "stats", key: "guji-li" })).scheduleCalls).toBe(before);
  });

  test("un client ne voit rien du Studio", async ({ browser }) => {
    const page = await (await browser.newContext({ storageState: authFile("INES") })).newPage();
    await page.goto("/admin/studio");
    await expect(page).toHaveURL(/\/client\/maison-colibri/);
    await page.goto("/client/maison-colibri/publications");
    await expect(page.getByText("Le Guji est de retour.")).toHaveCount(0);
  });

  test("l'envoi en validation crée un brouillon, sans jamais programmer ; un second envoi ne crée rien", async ({ browser, request }) => {
    const page = await (await browser.newContext({ storageState: authFile("ADMIN") })).newPage();
    const scheduleCalls = (await mockBuffer(request, { action: "stats", key: "guji-li" })).scheduleCalls;
    await page.goto("/admin/studio");
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await page.getByRole("button", { name: "Envoyer en validation" }).click();
    await page.getByRole("button", { name: "Créer les brouillons dans Buffer" }).click();
    await expect(page.getByTestId("buffer-state")).toContainText("1 brouillon dans Buffer");
    expect((await mockBuffer(request, { action: "stats", key: "guji-li" })).scheduleCalls).toBe(scheduleCalls);

    await page.getByRole("button", { name: "Renvoyer en validation" }).click();
    await page.getByRole("button", { name: "Mettre à jour dans Buffer" }).click();
    await expect(page.getByText("Ce contenu est déjà à jour dans Buffer.")).toBeVisible();
  });

  test("le client reçoit la publication, voit son texte complet et l'approuve", async ({ browser, request }) => {
    await syncViaApi(request);
    const page = await (await browser.newContext({ storageState: authFile("INES") })).newPage();
    await page.goto("/client/maison-colibri/a-valider");
    await page.getByRole("link", { name: /Le Guji est de retour\./ }).click();
    await expect(page.getByTestId("post-text")).toHaveText("Le Guji est de retour.\n\n#café #lyon");
    await page.getByRole("button", { name: "Approuver" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirmer l'approbation" }).click();
    await expect(page.getByText(/Publication approuvée/)).toBeVisible();
  });

  test("corriger le contenu après l'accord annule la validation", async ({ browser, request }) => {
    const admin = await (await browser.newContext({ storageState: authFile("ADMIN") })).newPage();
    await admin.goto("/admin/studio");
    await admin.getByRole("link", { name: new RegExp(title) }).click();
    await admin.getByLabel(/^Texte pour/).fill("Le Guji est de retour, en quantité limitée.");
    await expect(admin.getByTestId("save-status")).toHaveAttribute("data-status", "saved");
    await expect(admin.getByTestId("buffer-state")).toContainText("a changé depuis son envoi");
    await admin.getByRole("button", { name: "Renvoyer en validation" }).click();
    await admin.getByRole("button", { name: "Mettre à jour dans Buffer" }).click();
    await expect(admin.getByTestId("buffer-state")).toContainText("Envoyé en validation");
    await syncViaApi(request);

    const client = await (await browser.newContext({ storageState: authFile("INES") })).newPage();
    await client.goto("/client/maison-colibri/a-valider");
    await client.getByRole("link", { name: /en quantité limitée/ }).click();
    await expect(client.getByText("Cette proposition attend votre décision")).toBeVisible();
    await expect(client.getByTestId("versions")).toContainText("Version 1");
  });

  test("approbation groupée : seules les publications cochées sont approuvées", async ({ browser }) => {
    const page = await (await browser.newContext({ storageState: authFile("SOFIA") })).newPage();
    await page.goto("/client/nordwind-cycles/a-valider");
    // Les publications dont la date est dépassée ne sont pas sélectionnables : seules les autres comptent.
    const boxes = page.locator('input[type="checkbox"][aria-label^="Sélectionner"]:not([disabled])');
    const total = await boxes.count();
    test.skip(total < 2, "Il faut au moins deux publications approuvables en attente pour ce client.");
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.getByRole("button", { name: "Approuver la sélection" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirmer l'approbation" }).click();
    await expect(page.getByText("2 publications approuvées.")).toBeVisible();
    await expect(page.locator('input[type="checkbox"][aria-label^="Sélectionner"]:not([disabled])')).toHaveCount(total - 2 > 1 ? total - 2 : 0);
  });

  test("ménage : le contenu d'essai est archivé", async ({ browser }) => {
    const page = await (await browser.newContext({ storageState: authFile("ADMIN") })).newPage();
    await page.goto("/admin/studio");
    await page.locator("li").filter({ hasText: title }).getByRole("button", { name: "Archiver ce contenu" }).click();
    await expect(page.getByTestId("studio-drafts").getByText(title)).toHaveCount(0);
  });
});
