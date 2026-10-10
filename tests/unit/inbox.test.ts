import { describe, expect, it } from "vitest";

import { bufferUrl, buildInbox, inboxKeyOf, isUrgentPending } from "@/lib/domain/inbox";
import type { Post } from "@/lib/types";

const NOW = "2026-10-09T12:00:00.000Z";
const inHours = (hours: number) => new Date(Date.parse(NOW) + hours * 3_600_000).toISOString();
type Input = Parameters<typeof inboxKeyOf>[0];
let counter = 0;
const post = (overrides: Partial<Input> = {}): Input => ({
  id: `p${(counter += 1)}`, bufferStatus: "draft", approvalStatus: "none", scheduleState: "idle", dueAt: inHours(120), removedAt: null, submittedAt: null, ...overrides,
});

describe("à traiter : classement d'une publication", () => {
  it("un brouillon non soumis, une publication publiée ou supprimée ne demandent rien", () => {
    expect(inboxKeyOf(post(), NOW)).toBeNull();
    expect(inboxKeyOf(post({ bufferStatus: "sent", approvalStatus: "approved" }), NOW)).toBeNull();
    expect(inboxKeyOf(post({ approvalStatus: "pending", removedAt: NOW }), NOW)).toBeNull();
    expect(inboxKeyOf(post({ bufferStatus: "scheduled", approvalStatus: "approved", scheduleState: "scheduled" }), NOW)).toBeNull();
  });

  it("erreur Buffer ou échec de programmation", () => {
    expect(inboxKeyOf(post({ bufferStatus: "error" }), NOW)).toBe("errors");
    expect(inboxKeyOf(post({ approvalStatus: "approved", scheduleState: "failed" }), NOW)).toBe("errors");
  });

  it("programmée dans Buffer sans validation du client", () => {
    expect(inboxKeyOf(post({ bufferStatus: "scheduled" }), NOW)).toBe("unvalidated");
    expect(inboxKeyOf(post({ bufferStatus: "scheduled", approvalStatus: "pending" }), NOW)).toBe("unvalidated");
  });

  it("en retard : date passée sans publication, avec une tolérance pour une publication en cours d'envoi", () => {
    expect(inboxKeyOf(post({ approvalStatus: "pending", dueAt: inHours(-1) }), NOW)).toBe("late");
    expect(inboxKeyOf(post({ approvalStatus: "approved", dueAt: inHours(-1) }), NOW)).toBe("late");
    const scheduled = { bufferStatus: "scheduled" as const, approvalStatus: "approved" as const, scheduleState: "scheduled" as const };
    expect(inboxKeyOf(post({ ...scheduled, dueAt: inHours(-0.1) }), NOW)).toBeNull();
    expect(inboxKeyOf(post({ ...scheduled, dueAt: inHours(-1) }), NOW)).toBe("late");
    // Un brouillon jamais soumis dont la date est passée ne concerne personne.
    expect(inboxKeyOf(post({ dueAt: inHours(-1) }), NOW)).toBeNull();
  });

  it("modifications demandées et validations en attente", () => {
    expect(inboxKeyOf(post({ approvalStatus: "changes_requested" }), NOW)).toBe("changes");
    expect(inboxKeyOf(post({ approvalStatus: "pending" }), NOW)).toBe("pending");
    expect(inboxKeyOf(post({ approvalStatus: "pending", dueAt: null }), NOW)).toBe("pending");
  });

  it("une validation en attente est urgente à moins de 48 heures de la date prévue", () => {
    expect(isUrgentPending(post({ approvalStatus: "pending", dueAt: inHours(47) }), NOW)).toBe(true);
    expect(isUrgentPending(post({ approvalStatus: "pending", dueAt: inHours(49) }), NOW)).toBe(false);
    expect(isUrgentPending(post({ approvalStatus: "pending", dueAt: null }), NOW)).toBe(false);
  });
});

describe("à traiter : regroupement", () => {
  it("du plus grave au moins grave, sans groupe vide, la date la plus proche d'abord", () => {
    const later = post({ approvalStatus: "pending", dueAt: inHours(90) });
    const soon = post({ approvalStatus: "pending", dueAt: inHours(10) });
    const undated = post({ approvalStatus: "pending", dueAt: null });
    const failed = post({ bufferStatus: "error" });
    const inbox = buildInbox([later, undated, soon, failed, post()], NOW);
    expect(inbox.map((group) => group.key)).toEqual(["errors", "pending"]);
    expect(inbox[1].posts.map((item) => item.id)).toEqual([soon.id, later.id, undated.id]);
    expect(inbox[1].urgent).toBe(1);
    expect(buildInbox([post()], NOW)).toEqual([]);
  });
});

describe("lien vers Buffer", () => {
  const item = (bufferStatus: Post["bufferStatus"], bufferPostId = "abc") => ({ bufferPostId, bufferStatus });

  it("ouvre le canal sur l'onglet où se trouve la publication", () => {
    expect(bufferUrl(item("draft"), "64a5200a")).toBe("https://publish.buffer.com/channels/64a5200a?tab=drafts");
    expect(bufferUrl(item("sent"), "64a5200a")).toBe("https://publish.buffer.com/channels/64a5200a?tab=sent");
    expect(bufferUrl(item("scheduled"), "64a5200a")).toBe("https://publish.buffer.com/channels/64a5200a");
  });

  it("aucun lien pour les données simulées ou un canal inconnu", () => {
    expect(bufferUrl(item("draft", "mock-dev-guji"), "mock-ch-colibri-linkedin")).toBeNull();
    expect(bufferUrl(item("draft"), null)).toBeNull();
  });

  it("un identifiant de canal ne peut pas détourner l'adresse", () => {
    expect(bufferUrl(item("scheduled"), "x/../../evil?y=")).toBe("https://publish.buffer.com/channels/x%2F..%2F..%2Fevil%3Fy%3D");
  });
});

describe("cas ajoutés par la stabilisation", () => {
  const NOW = "2030-01-15T09:00:00.000Z";
  const base = { id: "p", bufferStatus: "draft" as const, approvalStatus: "none" as const, scheduleState: "idle" as const, dueAt: "2030-01-20T09:00:00.000Z", removedAt: null, submittedAt: null };

  it("un import à l'appartenance ambiguë est à attribuer", () => {
    expect(inboxKeyOf({ ...base, ownership: "ambiguous" }, NOW)).toBe("attribution");
    expect(inboxKeyOf({ ...base, ownership: "assigned" }, NOW)).toBeNull();
  });

  it("un post approuvé mais trop proche pour être programmé est signalé en retard avant d'être dépassé", () => {
    const soon = "2030-01-15T09:01:00.000Z";
    expect(inboxKeyOf({ ...base, approvalStatus: "approved", dueAt: soon }, NOW)).toBe("late");
    expect(inboxKeyOf({ ...base, approvalStatus: "approved" }, NOW)).toBeNull();
  });
});
