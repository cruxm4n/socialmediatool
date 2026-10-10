import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AttentionBanner } from "@/components/dashboard/attention-banner";
import { SyncView } from "@/components/dashboard/sync-view";
import { buildInbox } from "@/lib/domain/inbox";
import { NO_SYNC_STATUS, type SyncStatus } from "@/lib/domain/sync-health";

/*
 * Rendu des écrans d'administration ajoutés en V2, sans navigateur, sans base et sans réseau.
 * On vérifie ce que l'administrateur lit dans chaque situation.
 */

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@/components/shell/sync-button", () => ({ SyncButton: () => <button type="button">Synchroniser maintenant</button> }));

const NOW = "2026-10-09T12:00:00.000Z";
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

describe("bandeau « À traiter »", () => {
  const post = (id: string, overrides: Record<string, unknown>) => ({
    id, bufferStatus: "draft" as const, approvalStatus: "none" as const, scheduleState: "idle" as const, dueAt: "2026-10-20T09:00:00.000Z", removedAt: null, submittedAt: null, ...overrides,
  });

  it("regroupe par nature, compte, et renvoie vers la liste filtrée", () => {
    const html = renderToStaticMarkup(
      <AttentionBanner
        groups={buildInbox(
          [
            post("a", { bufferStatus: "error" }),
            post("b", { approvalStatus: "pending", dueAt: "2026-10-10T09:00:00.000Z" }),
            post("c", { approvalStatus: "pending" }),
            post("d", { approvalStatus: "approved", dueAt: "2026-10-08T09:00:00.000Z" }),
          ],
          NOW,
        )}
      />,
    );
    expect(text(html)).toContain("À traiter 4 publications");
    expect(html).toContain('href="/admin/publications?filtre=errors"');
    expect(html).toContain('href="/admin/publications?filtre=late"');
    expect(html).toContain('href="/admin/publications?filtre=pending"');
    expect(text(html)).toContain("1 à publier dans moins de 48 h.");
    expect(html.indexOf("filtre=errors")).toBeLessThan(html.indexOf("filtre=pending"));
  });

  it("dit clairement quand il n'y a rien à faire", () => {
    expect(text(renderToStaticMarkup(<AttentionBanner groups={[]} />))).toContain("Rien à traiter.");
  });
});

describe("écran Synchronisation", () => {
  const render = (status: Partial<SyncStatus>, extra: { interval?: number; quota?: Record<string, number> } = {}) =>
    text(
      renderToStaticMarkup(
        <SyncView
          status={{ ...NO_SYNC_STATUS, tracked: true, ...status }}
          intervalMinutes={extra.interval ?? 5}
          now={NOW}
          mode="real"
          reviewTag="À valider"
          runs={extra.quota ? [{ id: 1, mode: "real", status: "success", triggeredBy: "planifié", fetched: 3, created: 0, updated: 3, invalidated: 0, removed: 0, error: null, rateLimit: extra.quota, createdAt: ago(2) }] : []}
        />,
      ),
    );

  it("à jour, planificateur actif", () => {
    const page = render({ lastSuccessAt: ago(2), lastScheduledAt: ago(2) });
    expect(page).toContain("À jour il y a 2 min");
    expect(page).toContain("Actif, toutes les 5 min");
    expect(page).toContain("Dernier échec Jamais");
  });

  it("en échec : le motif et le dernier succès restent lisibles", () => {
    const page = render({ lastSuccessAt: ago(40), lastFailureAt: ago(3), lastError: "Buffer ne répond pas (délai dépassé).", consecutiveFailures: 2 });
    expect(page).toContain("Synchronisation en échec");
    expect(page).toContain("Buffer ne répond pas (délai dépassé).");
    expect(page).toContain("2 échecs de suite");
    expect(page).toContain("Dernier succès il y a 40 min");
  });

  it("planificateur pas encore activé, anomalies de la dernière exécution", () => {
    const page = render({ lastSuccessAt: ago(4), anomalies: ["1 publication(s) approuvée(s) n'ont pas pu être programmées dans Buffer."] });
    expect(page).toContain("Pas encore activé");
    expect(page).toContain("n'ont pas pu être programmées");
  });

  it("base sans la migration 0006 : le dit, sans rien inventer", () => {
    expect(render({ tracked: false, lastSuccessAt: ago(4) })).toContain("la base n'a pas la migration 0006");
  });

  it("prévient quand l'intervalle dépasse le quota mensuel du compte Buffer", () => {
    expect(render({ lastSuccessAt: ago(2) }, { quota: { "100-in-15min": 90, "3000-in-30days": 2500 } })).toContain("plus que le quota de ce compte Buffer");
    expect(render({ lastSuccessAt: ago(2) }, { interval: 15, quota: { "3000-in-30days": 2500 } })).not.toContain("plus que le quota");
    expect(render({ lastSuccessAt: ago(2) }, { quota: { "15000-in-30days": 14000 } })).not.toContain("plus que le quota");
  });
});
