import { expect, test } from "@playwright/test";

import { approve, authFile, automationHeaders, bufferId, mockBuffer, openPending, postLink, syncViaApi } from "./helpers";

/*
 * Parcours de validation, avec un Buffer simulé.
 * mockBuffer(...) imite une action faite à la main dans Buffer.
 */

test.describe("validation par le client", () => {
  test.use({ storageState: authFile("INES") });

  test("approuver reste interne à Cadence : rien n'est programmé dans Buffer, ni à l'approbation ni aux synchronisations", async ({ page, request }) => {
    const before = (await mockBuffer(request, { action: "stats", key: "guji-li" })).scheduleCalls;

    await openPending(page, "maison-colibri", "guji-li");
    await approve(page);
    await expect(page.getByText("Publication approuvée. Votre agence la programmera dans Buffer.")).toBeVisible();
    await expect(page.getByText("Publication approuvée et programmée dans Buffer.")).toHaveCount(0);
    await expect(page.locator('[data-status="approved"]').first()).toBeVisible();
    await expect(page.locator('[data-status="scheduled"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approuver" })).toHaveCount(0);
    await expect(page.getByText("Inès Faure a approuvé la version 1")).toBeVisible();

    // Dans Buffer, rien n'a bougé : toujours un brouillon, aucun appel de programmation.
    const stats = await mockBuffer(request, { action: "stats", key: "guji-li" });
    expect(stats.post.status).toBe("draft");
    expect(stats.scheduleCalls).toBe(before);

    // Les synchronisations ne programment rien non plus.
    await syncViaApi(request);
    await syncViaApi(request);
    const afterSync = await mockBuffer(request, { action: "stats", key: "guji-li" });
    expect(afterSync.post.status).toBe("draft");
    expect(afterSync.scheduleCalls).toBe(before);

    // L'agence programme à la main dans Buffer : Cadence le constate à la synchronisation, sans rien écrire.
    await mockBuffer(request, { action: "setStatus", key: "guji-li", status: "scheduled" });
    await syncViaApi(request);
    await page.reload();
    await expect(page.locator('[data-status="scheduled"]').first()).toBeVisible();
    expect((await mockBuffer(request, { action: "stats", key: "guji-li" })).scheduleCalls).toBe(before);

    // Une fois la décision prise, la fiche propose la publication suivante à valider.
    await page.getByRole("link", { name: "Publication suivante à valider" }).click();
    await expect(page.getByText("Cette proposition attend votre décision")).toBeVisible();

    await page.goto("/client/maison-colibri/a-valider");
    await expect(postLink(page, "guji-li")).toHaveCount(0);
  });

  test("une demande de modifications exige un commentaire", async ({ page }) => {
    await openPending(page, "maison-colibri", "atelier-ig");
    await page.getByRole("button", { name: "Demander des modifications" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Envoyer la demande" }).click();
    await expect(dialog.getByText("Décrivez la modification souhaitée avant d'envoyer.")).toBeVisible();

    await dialog.getByLabel("Votre demande").fill("Merci de préciser l'heure de l'atelier.");
    await dialog.getByRole("button", { name: "Envoyer la demande" }).click();
    await expect(page.locator('[data-status="changes_requested"]').first()).toBeVisible();
    await expect(page.getByText("Merci de préciser l'heure de l'atelier.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approuver" })).toHaveCount(0);
  });

  test("le client commente sans décider", async ({ page }) => {
    await openPending(page, "maison-colibri", "coulisses-tt");
    await page.getByLabel("Ajouter un commentaire").fill("Très bien, je regarde la vidéo ce soir.");
    await page.getByRole("button", { name: "Commenter" }).click();
    await expect(page.getByText("Très bien, je regarde la vidéo ce soir.")).toBeVisible();
    await expect(page.getByText("Cette proposition attend votre décision")).toBeVisible();
  });

  test("le calendrier client est en lecture seule et mène à la fiche", async ({ page }) => {
    await page.goto("/client/maison-colibri/calendrier");
    await expect(page.getByText("Les dates se modifient dans Buffer.")).toBeVisible();
    const chip = postLink(page, "atelier-fb");
    if ((await chip.count()) === 0) await page.getByRole("button", { name: "Période suivante" }).click();
    await chip.first().click();
    await expect(page).toHaveURL(/\/client\/maison-colibri\/publications\/[0-9a-f-]{36}$/);
  });
});

test("une publication dont la date est dépassée ne peut pas être approuvée", async ({ browser, request }) => {
  const sofia = await browser.newContext({ storageState: authFile("SOFIA") });
  const page = await sofia.newPage();
  await openPending(page, "nordwind-cycles", "expire-fb");
  await expect(page.getByText("La date prévue est dépassée")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approuver" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Demander des modifications" })).toBeEnabled();
  expect((await mockBuffer(request, { action: "stats", key: "expire-fb" })).post.status).toBe("draft");
  await sofia.close();
});

test("sur mobile, les deux décisions restent accessibles en bas de l'écran", async ({ browser }) => {
  const sofia = await browser.newContext({ storageState: authFile("SOFIA"), viewport: { width: 390, height: 844 } });
  const page = await sofia.newPage();
  await openPending(page, "nordwind-cycles", "essai-li");
  await expect(page.getByRole("button", { name: "Modifications", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Approuver" }).last()).toBeInViewport();
  for (const path of ["", "/calendrier", "/a-valider", "/publications", "/historique"]) {
    await page.goto(`/client/nordwind-cycles${path}`, { waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
  }
  await sofia.close();
});

test("une publication modifiée dans Buffer pendant la relecture ne peut pas être approuvée telle quelle", async ({ browser, request }) => {
  const context = await browser.newContext({ storageState: authFile("HUGO") });
  const page = await context.newPage();
  await openPending(page, "maison-colibri", "coulisses-tt");

  // Pendant que Hugo relit, l'agence change le texte dans Buffer et une synchronisation passe.
  await mockBuffer(request, { action: "editText", key: "coulisses-tt", text: "Nouveau texte écrit pendant la relecture du client." });
  await syncViaApi(request);

  await approve(page);
  await expect(page.getByText("La publication a été modifiée depuis son affichage.")).toBeVisible();
  // La page se met à jour avec la nouvelle version, toujours à valider, et rien n'a été programmé.
  await expect(page.getByTestId("post-text")).toHaveText("Nouveau texte écrit pendant la relecture du client.");
  await expect(page.getByText("TikTok · version 2")).toBeVisible();
  expect((await mockBuffer(request, { action: "stats", key: "coulisses-tt" })).post.status).toBe("draft");
  await context.close();
});

test("cycle complet : demande de modifications, correction dans Buffer, approbation, programmation manuelle dans Buffer", async ({ browser, request }) => {
  const scheduleCallsBefore = (await mockBuffer(request, { action: "stats", key: "fjord3-li" })).scheduleCalls;
  const sofia = await browser.newContext({ storageState: authFile("SOFIA") });
  const admin = await browser.newContext({ storageState: authFile("ADMIN") });
  const clientPage = await sofia.newPage();
  const adminPage = await admin.newPage();

  // 1. La cliente demande une modification.
  await openPending(clientPage, "nordwind-cycles", "fjord3-li");
  await clientPage.getByRole("button", { name: "Demander des modifications" }).click();
  await clientPage.getByRole("dialog").getByLabel("Votre demande").fill("Merci d'indiquer le prix de lancement.");
  await clientPage.getByRole("dialog").getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(clientPage.locator('[data-status="changes_requested"]').first()).toBeVisible();

  // 2. L'admin voit la demande.
  await adminPage.goto("/admin/publications");
  await postLink(adminPage, "fjord3-li").click();
  await expect(adminPage.getByText("Le client demande des modifications")).toBeVisible();
  await expect(adminPage.getByText("« Merci d'indiquer le prix de lancement. » — Sofia Lemaire")).toBeVisible();

  // 3. L'admin corrige le brouillon dans Buffer, puis synchronise depuis le dashboard.
  await mockBuffer(request, { action: "editText", key: "fjord3-li", text: "Le Fjord 3 est disponible en précommande, au prix de lancement de 4 990 € HT." });
  await adminPage.getByRole("button", { name: "Synchroniser" }).click();
  await expect(adminPage.getByText("Synchronisation terminée")).toBeVisible();
  await expect(adminPage.locator('[data-status="pending_approval"]').first()).toBeVisible();
  await expect(adminPage.getByText("Nouvelle version 2 soumise après modifications")).toBeVisible();

  // 4. La cliente approuve la version 2.
  await openPending(clientPage, "nordwind-cycles", "fjord3-li");
  await expect(clientPage.getByTestId("post-text")).toContainText("4 990 € HT");
  await approve(clientPage);
  await expect(clientPage.locator('[data-status="approved"]').first()).toBeVisible();

  // 5. L'approbation n'a rien écrit dans Buffer : l'admin voit l'accord et un brouillon à programmer.
  await adminPage.reload();
  await expect(adminPage.getByText("En attente de programmation dans Buffer.")).toBeVisible();
  expect((await mockBuffer(request, { action: "stats", key: "fjord3-li" })).post.status).toBe("draft");

  // 6. L'admin programme à la main dans Buffer ; Cadence le constate à la synchronisation.
  await mockBuffer(request, { action: "setStatus", key: "fjord3-li", status: "scheduled" });
  await adminPage.getByRole("button", { name: "Synchroniser" }).click();
  await expect(adminPage.getByText("Synchronisation terminée")).toBeVisible();
  await expect(adminPage.getByText("Programmée dans Buffer").first()).toBeVisible();
  await expect(adminPage.getByText("Version 2 approuvée par Sofia Lemaire")).toBeVisible();
  const final = await mockBuffer(request, { action: "stats", key: "fjord3-li" });
  expect(final.post.status).toBe("scheduled");
  // Aucune programmation n'est venue de Cadence, de bout en bout.
  expect(final.scheduleCalls).toBe(scheduleCallsBefore);

  await sofia.close();
  await admin.close();
});

test("modifier une publication approuvée et programmée annule la validation ; Cadence le signale sans rien déprogrammer", async ({ browser, request }) => {
  const ines = await browser.newContext({ storageState: authFile("INES") });
  const admin = await browser.newContext({ storageState: authFile("ADMIN") });
  const page = await ines.newPage();
  const adminPage = await admin.newPage();
  await openPending(page, "maison-colibri", "guji-ig");
  await approve(page);
  await expect(page.locator('[data-status="approved"]').first()).toBeVisible();
  // L'agence programme à la main dans Buffer, après l'accord.
  await mockBuffer(request, { action: "setStatus", key: "guji-ig", status: "scheduled" });
  await syncViaApi(request);
  expect((await mockBuffer(request, { action: "stats", key: "guji-ig" })).post.status).toBe("scheduled");

  // L'agence modifie ensuite le post programmé dans Buffer : la validation tombe.
  await mockBuffer(request, { action: "editText", key: "guji-ig", text: "Texte changé après la validation du client." });
  const response = await request.post("/api/automation/sync", { headers: automationHeaders() });
  // La synchronisation signale l'écart (502) : une publication est programmée sans accord valable.
  expect(response.status()).toBe(502);
  const result = await response.json();
  expect(result.invalidated).toBe(1);
  expect(result.unscheduled).toBe(0);
  expect(result.unscheduleFailures).toBe(1);
  expect(result.error).toContain("Repassez-les en brouillon dans Buffer");

  // Cadence n'a RIEN modifié dans Buffer : le post y est toujours programmé. L'administrateur est alerté.
  expect((await mockBuffer(request, { action: "stats", key: "guji-ig" })).post.status).toBe("scheduled");
  await adminPage.goto("/admin/publications");
  await postLink(adminPage, "guji-ig").click();
  await expect(adminPage.getByRole("alert").filter({ hasText: "Programmé dans Buffer sans validation du client" })).toBeVisible();
  await expect(adminPage.getByRole("alert").filter({ hasText: "repassez-le en brouillon dans Buffer (Cadence n'y modifie rien)" })).toBeVisible();

  // L'agence repasse le post en brouillon à la main : le retour est constaté, le client peut de nouveau décider.
  await mockBuffer(request, { action: "setStatus", key: "guji-ig", status: "draft" });
  const settled = await syncViaApi(request);
  expect(settled.unscheduled).toBe(1);
  expect(settled.unscheduleFailures).toBe(0);
  expect((await mockBuffer(request, { action: "stats", key: "guji-ig" })).post.status).toBe("draft");
  await admin.close();
  await page.goto("/client/maison-colibri/a-valider");
  await postLink(page, "guji-ig").click();
  await expect(page.getByText("Cette proposition attend votre décision")).toBeVisible();
  await expect(page.getByText("Validation annulée : le contenu a changé dans Buffer (version 2)")).toBeVisible();
  await ines.close();
});

test("un Buffer prêt à refuser une programmation n'est jamais sollicité : l'approbation aboutit sans incident", async ({ browser, request }) => {
  const hugo = await browser.newContext({ storageState: authFile("HUGO") });
  const admin = await browser.newContext({ storageState: authFile("ADMIN") });
  const clientPage = await hugo.newPage();
  const adminPage = await admin.newPage();

  // Le Buffer simulé échouerait à la prochaine programmation : comme Cadence n'en demande aucune, rien n'échoue.
  await mockBuffer(request, { action: "failNextSchedule", message: "Canal Facebook déconnecté (panne simulée)." });
  const before = (await mockBuffer(request, { action: "stats", key: "atelier-fb" })).scheduleCalls;
  await openPending(clientPage, "maison-colibri", "atelier-fb");
  await approve(clientPage);
  await expect(clientPage.getByText("Publication approuvée. Votre agence la programmera dans Buffer.")).toBeVisible();
  await expect(clientPage.getByText("La programmation dans Buffer n'a pas abouti")).toHaveCount(0);
  await expect(clientPage.getByText("Un incident technique retarde cette publication")).toHaveCount(0);
  await expect(clientPage.getByText("Canal Facebook déconnecté")).toHaveCount(0);

  await adminPage.goto("/admin/publications");
  await postLink(adminPage, "atelier-fb").click();
  await expect(adminPage.locator('[data-status="approved"]').first()).toBeVisible();
  await expect(adminPage.locator('[data-status="error"]')).toHaveCount(0);
  await expect(adminPage.getByText("En attente de programmation dans Buffer.")).toBeVisible();

  await adminPage.getByRole("button", { name: "Synchroniser" }).click();
  await expect(adminPage.getByText("Synchronisation terminée")).toBeVisible();
  await expect(adminPage.locator('[data-status="approved"]').first()).toBeVisible();
  const after = await mockBuffer(request, { action: "stats", key: "atelier-fb" });
  expect(after.post.status).toBe("draft");
  expect(after.scheduleCalls).toBe(before);

  await hugo.close();
  await admin.close();
});

test("un brouillon devient visible du client quand le tag est posé dans Buffer, et disparaît s'il est supprimé", async ({ browser, request }) => {
  const sofia = await browser.newContext({ storageState: authFile("SOFIA") });
  const page = await sofia.newPage();
  await page.goto("/client/nordwind-cycles/a-valider");
  await expect(postLink(page, "entretien-ig")).toHaveCount(0);

  await mockBuffer(request, { action: "setReviewTag", key: "entretien-ig", tagged: true });
  await syncViaApi(request);
  await page.reload();
  await expect(postLink(page, "entretien-ig")).toBeVisible();
  const detailUrl = (await postLink(page, "entretien-ig").getAttribute("href"))!;

  await mockBuffer(request, { action: "remove", key: "entretien-ig" });
  const result = await syncViaApi(request);
  expect(result.removed).toBe(1);
  await page.reload();
  await expect(postLink(page, "entretien-ig")).toHaveCount(0);

  // L'ancienne adresse de la fiche ne mène plus nulle part pour la cliente.
  await page.goto(detailUrl);
  await expect(page.getByText("Cette page n'existe pas.")).toBeVisible();
  await sofia.close();
});

test("le compte Buffer simulé ne contient aucune publication programmée sans validation par le dashboard", async ({ request }) => {
  // abonnement-li est programmé « à la main » dans le Buffer simulé dès le départ : le dashboard ne doit pas y toucher.
  const stats = await mockBuffer(request, { action: "stats", key: "abonnement-li" });
  expect(stats.post.id).toBe(bufferId("abonnement-li"));
  expect(stats.post.status).toBe("scheduled");
  // coldbrew-ig n'a jamais été soumis : il doit toujours être un brouillon.
  expect((await mockBuffer(request, { action: "stats", key: "coldbrew-ig" })).post.status).toBe("draft");
});
