import type { Metadata } from "next";
import Link from "next/link";
import { Check, X } from "lucide-react";

import { ConnectionsPanel } from "@/components/admin/connections-panel";
import { PageHeader } from "@/components/shared/page-header";
import { isArchived } from "@/lib/domain/clients";
import { requireAdmin } from "@/server/auth";
import { listConnectionEvents, listProviderConnections } from "@/server/connections";
import { credentialKeyAvailable } from "@/server/credentials";
import { getSyncStatus } from "@/server/data";
import { env, realBufferBlockedInDevelopment } from "@/server/env";
import { readiness } from "@/server/readiness";

export const metadata: Metadata = { title: "Paramètres" };

const SECTIONS = [
  ["general", "Général"],
  ["clients", "Clients"],
  ["integrations", "Intégrations"],
  ["publications", "Publications"],
  ["notifications", "Notifications"],
  ["securite", "Sécurité"],
  ["exploitation", "Exploitation"],
] as const;

const EVENT_LABELS: Record<string, string> = {
  created: "Connexion créée",
  credential_replaced: "Clé remplacée",
  verified: "Connexion vérifiée",
  revoked: "Connexion révoquée",
  revoke_refused: "Révocation refusée (opérations en attente)",
  collision: "Canal annoncé par un autre compte",
};

const dateTime = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso)) : "jamais";

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titre`} className="grid scroll-mt-24 grid-cols-1 gap-3">
      <div>
        <h2 id={`${id}-titre`} className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: { label: string; value: React.ReactNode; ok?: boolean; note?: string }[] }) {
  return (
    <ul className="overflow-hidden rounded-2xl border bg-card">
      {rows.map((row) => (
        <li key={row.label} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-3.5 last:border-b-0">
          {row.ok === undefined ? <span className="size-4 shrink-0" /> : row.ok ? <Check className="size-4 shrink-0 text-tone-green" /> : <X className="size-4 shrink-0 text-tone-red" />}
          <span className="w-56 shrink-0 text-sm font-semibold">{row.label}</span>
          <span className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">{row.value}</span>
          {row.note && <span className="text-xs text-muted-foreground">{row.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Paramètres de l'application, réservés à l'administrateur. Chaque ligne reflète un état RÉEL lu par le serveur ;
 * aucune valeur secrète n'est affichée. Ce qui ne se règle pas ici le dit explicitement.
 */
export default async function Page() {
  const session = await requireAdmin();
  const [connections, events, status, ready] = await Promise.all([listProviderConnections(), listConnectionEvents(12), getSyncStatus(), readiness()]);
  const active = session.organizations.filter((organization) => !isArchived(organization));
  const archived = session.organizations.length - active.length;
  const labels = new Map((connections ?? []).map((connection) => [connection.id, connection.label]));
  const simulated = env.bufferMode === "mock";

  return (
    <div className="grid animate-rise grid-cols-1 gap-8">
      <PageHeader title="Paramètres" description="Réglages de l'application, réservés à l'administrateur. Les paramètres propres à un client sont sur sa fiche." />
      <nav aria-label="Sections des paramètres" className="flex flex-wrap gap-2">
        {SECTIONS.map(([id, title]) => (
          <a key={id} href={`#${id}`} className="rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">{title}</a>
        ))}
      </nav>

      <Section id="general" title="Général" description="Identité de l'application et conventions d'affichage.">
        <Rows rows={[
          { label: "Application", value: "Cadence" },
          { label: "Langue", value: "Français", note: "non modifiable" },
          { label: "Fuseau d'affichage", value: "Celui de chaque client (fiche client)", note: "Europe/Paris par défaut" },
          { label: "Adresse publique", value: env.appUrl ?? "Non définie : les notifications n'ont pas de lien", ok: Boolean(env.appUrl) },
        ]} />
      </Section>

      <Section id="clients" title="Clients" description="Les clients, leurs utilisateurs, leurs canaux et leurs comptes Buffer se gèrent depuis leur fiche.">
        <Rows rows={[
          { label: "Clients actifs", value: <Link href="/admin/clients" className="font-medium text-foreground underline-offset-4 hover:underline">{active.length} client{active.length > 1 ? "s" : ""}</Link> },
          { label: "Clients archivés", value: `${archived}`, note: "leurs utilisateurs n'ont plus accès" },
          { label: "Rôles", value: "Administrateur, client", note: "attribués par l'administrateur" },
        ]} />
      </Section>

      <Section id="integrations" title="Intégrations" description="Comptes Buffer reliés à Cadence. Chaque canal reste lié au compte dont il provient : une publication ne part jamais par un autre compte.">
        <Rows rows={[
          {
            label: "Mode du serveur",
            value: simulated ? "Simulé : aucun appel à Buffer, données fictives" : "Réel : les opérations sont envoyées à Buffer",
            note: realBufferBlockedInDevelopment() ? "mode réel ignoré en développement" : undefined,
          },
          { label: "Chiffrement des clés", value: credentialKeyAvailable() ? "Disponible : les clés sont chiffrées avant enregistrement" : "Indisponible : aucune clé Buffer ne peut être enregistrée", ok: credentialKeyAvailable() },
        ]} />
        {connections === null ? (
          <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Les connexions demandent la migration 0012 de la base de données.</p>
        ) : (
          <ConnectionsPanel
            connections={connections}
            organizations={active.map((organization) => ({ id: organization.id, name: organization.name }))}
            serverMode={env.bufferMode}
            canStoreKeys={credentialKeyAvailable()}
          />
        )}
      </Section>

      <Section id="publications" title="Publications" description="Règles appliquées à toute publication. Elles sont fixées par l'application et ne se désactivent pas.">
        <Rows rows={[
          { label: "Validation", value: "Aucune programmation sans accord du client sur la version exacte" },
          { label: "Tag de soumission", value: `« ${env.reviewTag} »`, note: "posé dans Buffer" },
          { label: "Profil", value: env.profile === "pilot" ? "Pilote : échéance d'au moins 24 h à chaque programmation" : "Standard" },
          { label: "Résultat inconnu", value: "Jamais de renvoi automatique : le brouillon est retrouvé, ou son absence confirmée par une personne" },
          { label: "Synchronisation", value: <Link href="/admin/synchronisation" className="font-medium text-foreground underline-offset-4 hover:underline">Dernière réussie : {dateTime(status.lastSuccessAt)}</Link>, ok: status.consecutiveFailures === 0 },
          { label: "Annulations à confirmer", value: `${status.urgent.pendingCancellations}`, ok: status.urgent.pendingCancellations === 0 },
        ]} />
      </Section>

      <Section id="notifications" title="Notifications" description="Messages envoyés aux clients et à l'administrateur.">
        <Rows rows={[
          { label: "Mode", value: env.notificationMode === "webhook" && !simulated ? "Envoi réel" : "Simulation : aucun message ne sort du serveur" },
          { label: "Contenu", value: env.notificationContent === "minimal" ? "Minimal : aucun texte de publication dans les messages" : "Complet" },
          { label: "Préférences", value: <Link href="/admin/notifications" className="font-medium text-foreground underline-offset-4 hover:underline">Journal et préférences</Link> },
        ]} />
      </Section>

      <Section id="securite" title="Sécurité" description="Accès et opérations sensibles. Les secrets ne sont jamais affichés.">
        <Rows rows={[
          { label: "Inscription publique", value: "Fermée : les comptes sont créés par l'administrateur" },
          { label: "Secret d'automatisation", value: process.env.AUTOMATION_SECRET ? "Présent" : "Absent", ok: Boolean(process.env.AUTOMATION_SECRET) },
          { label: "Clés Buffer", value: "Chiffrées en base, déchiffrées par le serveur uniquement, jamais envoyées au navigateur" },
        ]} />
        <div className="rounded-2xl border bg-card">
          <p className="border-b px-5 py-3 text-sm font-semibold">Journal des connexions</p>
          {events.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">Aucune opération enregistrée.</p>
          ) : (
            <ul>
              {events.map((event) => (
                <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b px-5 py-2.5 text-sm last:border-b-0">
                  <span className="w-32 shrink-0 text-xs text-muted-foreground">{dateTime(event.createdAt)}</span>
                  <span className="font-medium">{EVENT_LABELS[event.type] ?? event.type}</span>
                  <span className="text-muted-foreground">{labels.get(event.connectionId) ?? "connexion"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section id="exploitation" title="Exploitation" description="État du service. Les sauvegardes et les alertes sont suivies par la supervision du serveur, hors de l'application.">
        <Rows rows={[
          { label: "Version déployée", value: <code className="font-mono text-xs">{ready.version}</code> },
          { label: "Préparation au service", value: ready.ready ? "Prêt" : "Incomplet", ok: ready.ready },
          ...ready.checks.filter((check) => !check.ok).map((check) => ({ label: "À corriger", value: check.name, ok: false })),
          { label: "Planificateur", value: status.lastScheduledAt ? `Dernier passage : ${dateTime(status.lastScheduledAt)}` : "Jamais passé", note: `toutes les ${env.syncIntervalMinutes} min` },
          { label: "Dernier échec", value: status.lastFailureAt ? `${dateTime(status.lastFailureAt)} — ${status.lastError ?? ""}` : "Aucun" },
          { label: "Sauvegardes", value: "Suivies hors de l'application (supervision du serveur)", note: "voir RUNBOOK" },
        ]} />
      </Section>
    </div>
  );
}
