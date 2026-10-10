import { describe, expect, it } from "vitest";

import { ADMIN_ERRORS, initialsFor, isArchived, matchesClientSearch, slugify, sortChannels } from "@/lib/domain/clients";
import { buildPostViews } from "@/lib/view";
import type { Channel, Organization, Post } from "@/lib/types";

const organization = (overrides: Partial<Organization> = {}): Organization => ({
  id: "o1", slug: "maison-colibri", name: "Maison Colibri", sector: "Torréfaction", timezone: "Europe/Paris", initials: "MC", color: "#1f4f8f", archivedAt: null, ...overrides,
});
const channel = (overrides: Partial<Channel> = {}): Channel => ({
  id: "c1", bufferChannelId: "b1", service: "linkedin", name: "Colibri", displayName: null, avatarUrl: null, isDisconnected: false,
  organizationId: "o1", lastOrganizationId: "o1", visibleFrom: null, ...overrides,
});

describe("adresse et initiales d'un client", () => {
  it("forme une adresse lisible, sans accents ni symboles", () => {
    expect(slugify("Maison Colibri")).toBe("maison-colibri");
    expect(slugify("  Café & Thé — Évasion!  ")).toBe("cafe-the-evasion");
    expect(slugify("Studio 54")).toBe("studio-54");
    expect(slugify("★★★")).toBe("");
    expect(slugify("a".repeat(58) + " bcd")).toBe("a".repeat(58) + "-b");
  });

  it("forme deux initiales en capitales", () => {
    expect(initialsFor("Maison Colibri")).toBe("MC");
    expect(initialsFor("nordwind cycles bikes")).toBe("NC");
    expect(initialsFor("Évasion")).toBe("EV");
    expect(initialsFor("L'Atelier d'Inès")).toBe("LA");
    expect(initialsFor("   ")).toBe("");
  });
});

describe("liste des clients", () => {
  it("cherche dans le nom, le secteur et les canaux, sans tenir compte des accents", () => {
    const channels = [channel({ name: "Colibri Café", service: "instagram" })];
    for (const query of ["", "colibri", "torrefaction", "INSTAGRAM", "cafe"]) expect(matchesClientSearch(organization(), channels, query), query).toBe(true);
    expect(matchesClientSearch(organization(), channels, "nordwind")).toBe(false);
  });

  it("distingue les clients archivés", () => {
    expect(isArchived(organization())).toBe(false);
    expect(isArchived(organization({ archivedAt: "2026-10-09T10:00:00Z" }))).toBe(true);
  });

  it("présente d'abord les canaux sans client, puis par réseau et par nom", () => {
    const sorted = sortChannels([
      channel({ id: "1", service: "linkedin", name: "Zed" }),
      channel({ id: "2", service: "instagram", name: "Beta" }),
      channel({ id: "3", service: "twitter", name: "Libre", organizationId: null }),
      channel({ id: "4", service: "instagram", name: "Alpha", displayName: "Alpha" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["3", "4", "2", "1"]);
  });

  it("chaque refus de la base a un message lisible", () => {
    for (const message of Object.values(ADMIN_ERRORS)) expect(message.length).toBeGreaterThan(10);
  });
});

describe("publications d'un canal transféré", () => {
  const post = (id: string, createdAt: string) =>
    ({ id, channelId: "c1", service: "linkedin", text: id, bufferStatus: "draft", approvalStatus: "pending", scheduleState: "idle", createdAt }) as Post;

  it("celles d'avant le transfert ne sont plus présentées comme appartenant au nouveau client", () => {
    const transferred = channel({ organizationId: "o2", visibleFrom: "2026-10-09T12:00:00.000Z" });
    const views = buildPostViews(
      [post("avant", "2026-10-01T08:00:00.000Z"), post("apres", "2026-10-09T12:00:01.000Z")],
      [transferred],
      [organization(), organization({ id: "o2", name: "Nordwind" })],
    );
    expect(views.map((view) => [view.id, view.organization?.name ?? null])).toEqual([["avant", null], ["apres", "Nordwind"]]);
  });

  it("sans transfert, toutes appartiennent au client du canal", () => {
    const [view] = buildPostViews([post("p", "2026-10-01T08:00:00.000Z")], [channel()], [organization()]);
    expect(view.organization?.name).toBe("Maison Colibri");
  });
});
