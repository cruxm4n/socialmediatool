import { describe, expect, it } from "vitest";

import type { Channel, Organization, Post } from "@/lib/types";
import { buildPostViews } from "@/lib/view";

/*
 * (Mission V3, C07) Le client affiché d'une publication est son propriétaire explicite, jamais le client actuel du
 * canal ni une date d'import ; le propriétaire historique se distingue du propriétaire actuel du canal.
 */

const org = (id: string, timezone: string): Organization => ({ id, slug: id, name: id.toUpperCase(), timezone } as unknown as Organization);
const A = org("a", "America/New_York");
const B = org("b", "Asia/Tokyo");
const channel = (organizationId: string | null, visibleFrom: string | null = null): Channel =>
  ({ id: "c1", bufferChannelId: "bc1", service: "linkedin", organizationId, visibleFrom } as unknown as Channel);
const post = (overrides: Partial<Post>): Post =>
  ({
    id: "p1", channelId: "c1", service: "linkedin", text: "Texte", bufferStatus: "draft", approvalStatus: "pending", removedAt: null, scheduleState: "idle",
    createdAt: "2026-10-10T10:00:00.000Z", dueAt: "2030-01-01T10:00:00.000Z", ownership: "assigned", ownerOrganizationId: "a", ...overrides,
  }) as unknown as Post;

describe("propriété explicite dans les vues", () => {
  it("assignée à A, canal désormais à B, import récent : affichée au nom de A, avec son fuseau", () => {
    const [view] = buildPostViews([post({})], [channel("b", "2026-10-10T09:00:00.000Z")], [A, B]);
    expect(view.organization?.id).toBe("a");
    expect(view.timezone).toBe("America/New_York");
    expect(view.channelOrganization?.id).toBe("b");
    expect(view.ownerDiffersFromChannel).toBe(true);
  });

  it("ambiguë ou non attribuée : aucun client, jamais celui du canal ; fuseau par défaut", () => {
    for (const ownership of ["ambiguous", "unassigned"] as const) {
      const [view] = buildPostViews([post({ ownership, ownerOrganizationId: null })], [channel("b")], [A, B]);
      expect(view.organization).toBeNull();
      expect(view.timezone).toBe("Europe/Paris");
      expect(view.ownerDiffersFromChannel).toBe(false);
    }
  });

  it("ambiguë même avec un propriétaire résiduel dans la ligne : le propriétaire n'est pas déduit", () => {
    const [view] = buildPostViews([post({ ownership: "ambiguous", ownerOrganizationId: "a" })], [channel("a")], [A, B]);
    expect(view.organization).toBeNull();
  });

  it("canal absent du résultat (RLS) : le propriétaire reste affiché, sans client de canal", () => {
    const [view] = buildPostViews([post({})], [], [A, B]);
    expect(view.organization?.id).toBe("a");
    expect(view.channel).toBeNull();
    expect(view.channelOrganization).toBeNull();
    expect(view.ownerDiffersFromChannel).toBe(false);
  });

  it("client propriétaire archivé ou inconnu de la liste : aucun client déduit, pas de repli sur le canal", () => {
    const [view] = buildPostViews([post({ ownerOrganizationId: "zzz" })], [channel("b")], [A, B]);
    expect(view.organization).toBeNull();
  });

  it("propriétaire = client du canal : aucune différence signalée", () => {
    const [view] = buildPostViews([post({})], [channel("a")], [A, B]);
    expect(view.ownerDiffersFromChannel).toBe(false);
  });

  it("ancien schéma (sans colonne de propriété) : repli sur le canal avec masquage de l'avant-transfert", () => {
    const legacy = { ...post({}), ownership: undefined, ownerOrganizationId: undefined } as unknown as Post;
    const [shown] = buildPostViews([legacy], [channel("b", "2026-10-09T00:00:00.000Z")], [A, B]);
    expect(shown.organization?.id).toBe("b");
    const [hidden] = buildPostViews([legacy], [channel("b", "2026-10-11T00:00:00.000Z")], [A, B]);
    expect(hidden.organization).toBeNull();
  });
});
