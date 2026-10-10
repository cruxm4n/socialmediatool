import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalDb, type Actor } from "../support/local-db";

/*
 * Migration 0007 : mise en file d'attente des notifications, anti-doublon, préférences, remise.
 * Base PostgreSQL locale en mémoire. Aucun message n'est envoyé : la base ne fait que préparer.
 */

let db: LocalDb;
afterEach(() => db?.close());

type Seed = Awaited<ReturnType<LocalDb["seed"]>>;
const queued = async (kind?: string) =>
  db.sql<{ kind: string; recipient: string; status: string; mode: string; detail: string | null }>(
    `select n.kind, pr.full_name as recipient, n.status, n.mode, n.detail from public.notifications n join public.profiles pr on pr.id = n.recipient_id
     ${kind ? "where n.kind = $1" : ""} order by n.created_at, pr.full_name`,
    kind ? [kind] : [],
  );
const prefs = (actor: Actor, values: Partial<Record<"review" | "changes" | "approved" | "errors", boolean>>) =>
  db.as(actor, "select public.set_notification_preferences($1, $2, $3, $4)", [values.review ?? null, values.changes ?? null, values.approved ?? null, values.errors ?? null]);
const claim = (mode = "real") => db.automation<{ id: string; kind: string; recipient_email: string; organization_slug: string; post_text: string }>("claim_notifications", { p_mode: mode });
const complete = async (ids: string[], status: string, error: string | null = null) =>
  (await db.as<{ n: number }>("anon", "select public.complete_notifications($1, $2::uuid[], $3, $4) as n", ["secret-local-de-test", ids, status, error]))[0].n;
const start = async (): Promise<Seed> => {
  db = await LocalDb.create();
  return db.seed();
};

describe("ce qui déclenche une notification", () => {
  it("publication soumise → les utilisateurs du client concerné, et personne d'autre", async () => {
    await start();
    await db.sync([{ id: "a" }, { id: "b", channelId: "canal-nordwind" }, { id: "brouillon", hasReviewTag: false }, { id: "libre", channelId: "canal-libre" }]);
    expect(await queued()).toEqual([
      { kind: "review_requested", recipient: "ines", status: "pending", mode: "real", detail: null },
      { kind: "review_requested", recipient: "sofia", status: "pending", mode: "real", detail: null },
    ]);
  });

  it("demande de modifications → l'administrateur, avec le commentaire du client", async () => {
    const { ines } = await start();
    await db.sync([{ id: "a" }]);
    await db.decide(ines, "a", "changes_requested", "Remplacer la photo.");
    expect(await queued("changes_requested")).toEqual([{ kind: "changes_requested", recipient: "admin", status: "pending", mode: "real", detail: "Remplacer la photo." }]);
  });

  it("approbation → l'administrateur seulement s'il l'a demandé", async () => {
    const { admin, ines } = await start();
    await db.sync([{ id: "a" }, { id: "b" }]);
    await db.decide(ines, "a", "approved");
    expect(await queued("approved")).toEqual([]);
    await prefs(admin, { approved: true });
    await db.decide(ines, "b", "approved");
    expect(await queued("approved")).toHaveLength(1);
  });

  it("échec de programmation → l'administrateur, une seule fois par version malgré les nouvelles tentatives", async () => {
    const { ines } = await start();
    await db.sync([{ id: "a" }]);
    await db.decide(ines, "a", "approved");
    const post = await db.post("a");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [reserved] = await db.automation<{ token: string }>("claim_posts_for_scheduling_in_mode", { p_mode: "real", p_post_id: post.id });
      await db.automation("complete_scheduling", { p_post_id: post.id, p_ok: false, p_error: "Canal déconnecté", p_token: reserved.token });
    }
    expect(await queued("schedule_error")).toEqual([{ kind: "schedule_error", recipient: "admin", status: "pending", mode: "real", detail: "Canal déconnecté" }]);
  });

  it("erreur de publication signalée par Buffer → l'administrateur", async () => {
    await start();
    await db.sync([{ id: "a", status: "scheduled", hasReviewTag: false }]);
    await db.sync([{ id: "a", status: "error", hasReviewTag: false }]);
    expect(await queued("schedule_error")).toHaveLength(1);
  });

  it("contenu modifié après accord → le client est de nouveau prévenu, pour la nouvelle version", async () => {
    const { ines } = await start();
    await db.sync([{ id: "a" }]);
    await db.decide(ines, "a", "approved");
    await db.sync([{ id: "a", text: "Texte corrigé" }]);
    expect(await queued("review_requested")).toHaveLength(2);
  });
});

describe("anti-doublon et silence", () => {
  it("resynchroniser sans changement ne notifie pas une seconde fois", async () => {
    await start();
    await db.sync([{ id: "a" }]);
    await db.sync([{ id: "a" }]);
    await db.sync([{ id: "a" }], { complete: true });
    expect(await queued()).toHaveLength(1);
  });

  it("un utilisateur qui a coupé les notifications n'en reçoit plus ; le réactiver suffit", async () => {
    const { ines } = await start();
    await prefs(ines, { review: false });
    await db.sync([{ id: "a" }]);
    expect(await queued()).toEqual([]);
    await prefs(ines, { review: true });
    await db.sync([{ id: "b" }]);
    expect(await queued()).toHaveLength(1);
  });

  it("un client archivé ou un canal transféré ne notifie pas pour les publications qu'il ne voit pas", async () => {
    const { admin, colibri, nordwind } = await start();
    await db.sync([{ id: "avant" }]);
    await db.as(admin, "select public.admin_set_organization_archived($1, true)", [colibri]);
    await db.sync([{ id: "pendant" }]);
    expect(await queued()).toHaveLength(1);

    await db.as(admin, "select public.admin_set_organization_archived($1, false)", [colibri]);
    const [{ id: channel }] = await db.sql<{ id: string }>("select id from public.channels where buffer_channel_id = 'canal-colibri'");
    await db.as(admin, "select public.admin_assign_channel($1, $2, true)", [channel, nordwind]);
    // Une publication d'avant le transfert change : le nouveau client ne la voit pas, il n'est pas prévenu.
    await db.sync([{ id: "avant", text: "Modifié" }, { id: "pendant", hasReviewTag: false }]);
    expect((await queued()).map((row) => row.recipient)).toEqual(["ines"]);
  });

  it("les publications simulées sont rangées à part et ne sont jamais réservées en mode réel", async () => {
    await start();
    await db.sync([{ id: "mock-dev-a" }], { mode: "mock" });
    expect(await queued()).toMatchObject([{ mode: "mock" }]);
    expect(await claim("real")).toEqual([]);
    expect(await claim("mock")).toHaveLength(1);
  });
});

describe("remise", () => {
  it("une demande de validation devenue sans objet est annulée, pas envoyée", async () => {
    const { ines } = await start();
    await db.sync([{ id: "validee" }, { id: "retiree" }, { id: "modifiee" }, { id: "en-attente" }]);
    await db.decide(ines, "validee", "approved");
    await db.sync([{ id: "validee" }, { id: "retiree", hasReviewTag: false }, { id: "modifiee", text: "Nouvelle version" }, { id: "en-attente" }]);
    // « modifiee » attend toujours une décision : sa demande part, avec le texte à jour.
    expect((await claim()).map((row) => row.post_text).sort()).toEqual(["Nouvelle version", "Texte"]);
    expect((await queued()).map((row) => row.status).sort()).toEqual(["cancelled", "cancelled", "sending", "sending"]);
  });

  it("réserve chaque notification une seule fois, avec ce qu'il faut pour écrire le message", async () => {
    await start();
    await db.sync([{ id: "a", text: "Bonjour" }]);
    const [first] = await claim();
    expect(first).toMatchObject({ kind: "review_requested", recipient_email: "ines@test.example", organization_slug: "colibri", post_text: "Bonjour" });
    expect(await claim()).toEqual([]);
    expect(await complete([first.id], "simulated")).toBe(1);
    expect(await queued()).toMatchObject([{ status: "simulated" }]);
    // Une notification déjà traitée ne change plus d'état.
    expect(await complete([first.id], "failed", "tardif")).toBe(0);
    expect(await queued()).toMatchObject([{ status: "simulated" }]);
  });

  it("un échec est retenté plus tard, cinq fois au plus", async () => {
    await start();
    await db.sync([{ id: "a" }]);
    const [first] = await claim();
    await complete([first.id], "failed", "Webhook injoignable");
    expect(await claim()).toEqual([]);
    await db.sql("update public.notifications set claimed_at = now() - interval '20 minutes'");
    expect(await claim()).toHaveLength(1);
    await complete([first.id], "failed", "Webhook injoignable");
    await db.sql("update public.notifications set claimed_at = now() - interval '20 minutes', attempts = 5");
    expect(await claim()).toEqual([]);
  });

  it("refuse un mauvais secret, un mode ou un statut inconnu", async () => {
    await start();
    await expect(db.automation("claim_notifications", { p_mode: "real" }, "mauvais")).rejects.toThrow("invalid_secret");
    await expect(claim("autre")).rejects.toThrow("invalid_mode");
    await expect(complete([], "lu")).rejects.toThrow("invalid_status");
  });
});

describe("droits", () => {
  it("chacun ne lit que ses notifications et ses préférences ; l'administrateur voit tout ; aucune écriture directe", async () => {
    const { admin, ines, sofia } = await start();
    await db.sync([{ id: "a" }, { id: "b", channelId: "canal-nordwind" }]);
    await prefs(ines, { review: true });
    await prefs(sofia, { review: true });
    const count = async (actor: Actor, table: string) => Number((await db.as<{ n: string }>(actor, `select count(*) as n from public.${table}`))[0].n);
    expect(await count(ines, "notifications")).toBe(1);
    expect(await count(sofia, "notifications")).toBe(1);
    expect(await count(admin, "notifications")).toBe(2);
    expect(await count(ines, "notification_preferences")).toBe(1);
    expect(await count(admin, "notification_preferences")).toBe(2);
    await expect(db.as(ines, "update public.notifications set status = 'sent'")).rejects.toThrow(/permission denied/);
    await expect(db.as(ines, "insert into public.notification_preferences (user_id) values ($1)", [sofia.userId])).rejects.toThrow(/permission denied/);
    await expect(db.as("anon", "select public.set_notification_preferences(true)")).rejects.toThrow(/permission denied/);
  });
});

describe("montée de version et retour arrière de 0007", () => {
  it("ne notifie rien pour le passé, se rejoue, et se retire sans perdre l'historique", async () => {
    db = await LocalDb.create("0006");
    const { ines } = await db.seed();
    await db.sync([{ id: "ancien" }]);
    await db.migrate("0007_notifications.sql");
    await db.migrate("0007_notifications.sql");
    expect(await queued()).toEqual([]);
    await db.sync([{ id: "nouveau" }]);
    expect(await queued()).toHaveLength(1);

    await db.exec(readFileSync(resolve(process.cwd(), "supabase/outils/0007_retour_arriere.sql"), "utf8"));
    await db.sync([{ id: "apres" }]);
    await db.decide(ines, "apres", "approved");
    expect(await queued()).toHaveLength(1);
    await db.migrate("0007_notifications.sql");
    expect(await queued()).toHaveLength(1);
  });
});
