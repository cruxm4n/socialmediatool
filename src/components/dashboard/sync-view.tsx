import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { TONE_CLASSES } from "@/components/shared/status-badge";
import { SyncButton } from "@/components/shell/sync-button";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { monthlyRequests, syncHealth, type SyncStatus } from "@/lib/domain/sync-health";
import { cn } from "@/lib/utils";
import type { SyncRun } from "@/lib/types";
import { DEFAULT_TIMEZONE } from "@/lib/view";

const QUOTA_LABELS: Record<string, string> = {
  "100-in-15min": "sur 15 minutes",
  "250-in-1day": "sur 24 heures",
  "500-in-1day": "sur 24 heures",
  "3000-in-30days": "sur 30 jours",
  "15000-in-30days": "sur 30 jours",
};

function Moment({ label, iso, now, children }: { label: string; iso: string | null; now: string; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-sm">
        {iso ? (
          <>
            <span className="font-semibold">{formatRelative(iso, now)}</span>
            <span className="block text-xs text-muted-foreground tabular-nums">{formatDateTime(iso, DEFAULT_TIMEZONE)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">Jamais</span>
        )}
        {children}
      </dd>
    </div>
  );
}

export function SyncView({
  runs,
  status,
  intervalMinutes,
  now,
  mode,
  reviewTag,
}: {
  runs: SyncRun[];
  status: SyncStatus;
  intervalMinutes: number;
  now: string;
  mode: "real" | "mock";
  reviewTag: string;
}) {
  const lastQuota = runs.find((run) => run.rateLimit)?.rateLimit;
  const health = syncHealth(status, now, intervalMinutes);
  const monthlyQuota = Object.entries(lastQuota ?? {}).find(([window]) => window.endsWith("-in-30days"))?.[0].split("-")[0];
  const overQuota = monthlyQuota !== undefined && monthlyRequests(intervalMinutes) > Number(monthlyQuota);

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader
        title="Synchronisation"
        description="Chaque synchronisation lit Buffer et met à jour les publications. Rien n'est modifié dans Buffer : la programmation s'y fait à la main."
        actions={<SyncButton variant="default" label="Synchroniser maintenant" />}
      />

      <section aria-labelledby="sync-state-title" className="rounded-2xl border bg-card p-5" data-testid="sync-state" data-level={health.level}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="sync-state-title" className="sr-only">
            État de la synchronisation
          </h2>
          <span className={cn("inline-flex h-7 items-center gap-2 rounded-full px-3 text-sm font-semibold", TONE_CLASSES[health.tone].badge)}>
            <span className={cn("size-2 rounded-full", TONE_CLASSES[health.tone].dot, health.level === "running" && "animate-pulse")} aria-hidden="true" />
            {health.label}
          </span>
          <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">{health.detail}</p>
        </div>

        <dl className="mt-5 grid grid-cols-1 gap-4 border-t pt-4 sm:grid-cols-3">
          <Moment label="Dernier succès" iso={status.lastSuccessAt} now={now} />
          <Moment label="Dernier échec" iso={status.lastFailureAt} now={now}>
            {status.lastFailureAt && status.lastError && <span className="mt-1 block text-xs text-tone-red">{status.lastError}</span>}
          </Moment>
          <div className="min-w-0">
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Planificateur</dt>
            <dd className="mt-1 text-sm">
              {!status.tracked ? (
                <span className="text-muted-foreground">Suivi indisponible : la base n&apos;a pas la migration 0006.</span>
              ) : status.lastScheduledAt ? (
                <>
                  <span className="font-semibold">{health.schedulerActive ? `Actif, toutes les ${intervalMinutes} min` : "Silencieux"}</span>
                  <span className="block text-xs text-muted-foreground">Dernier passage {formatRelative(status.lastScheduledAt, now)}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Pas encore activé : la synchronisation se lance à l&apos;ouverture de cet espace ou avec le bouton.</span>
              )}
            </dd>
          </div>
        </dl>

        {(status.urgent.pendingCancellations > 0 || status.urgent.staleClaims > 0) && (
          <div className="mt-4 rounded-xl border border-tone-red/40 bg-tone-red-soft p-4 text-sm" data-testid="sync-urgent" role="alert">
            <p className="flex items-start gap-2 font-semibold text-tone-red">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {status.urgent.pendingCancellations > 0
                ? `${status.urgent.pendingCancellations} publication${status.urgent.pendingCancellations > 1 ? "s" : ""} programmée${status.urgent.pendingCancellations > 1 ? "s" : ""} dans Buffer sans accord valable — à repasser en brouillon dans Buffer`
                : `${status.urgent.staleClaims} programmation${status.urgent.staleClaims > 1 ? "s" : ""} en cours depuis longtemps`}
            </p>
            <ul className="mt-2 grid gap-1 text-foreground">
              {status.urgent.pendingCancellations > 0 && (
                <>
                  <li>En attente {status.urgent.oldestSince ? formatRelative(status.urgent.oldestSince, now) : "depuis un instant"}.</li>
                  {status.urgent.earliestDue && <li>Échéance la plus proche : {formatRelative(status.urgent.earliestDue, now)} — si Buffer reste injoignable, la publication peut partir.</li>}
                  <li>
                    {status.urgent.attempts} tentative{status.urgent.attempts > 1 ? "s" : ""}
                    {status.urgent.lastAttemptAt ? `, dernier essai ${formatRelative(status.urgent.lastAttemptAt, now)}` : ", aucun essai pour l'instant"}.
                  </li>
                  {status.urgent.lastAttemptError && <li className="text-xs text-muted-foreground">Dernière erreur : {status.urgent.lastAttemptError}</li>}
                  <li>Cadence ne modifie rien dans Buffer : repassez ces publications en brouillon dans Buffer. Le retour en brouillon est constaté à la synchronisation suivante.</li>
                </>
              )}
              {status.urgent.staleClaims > 0 && <li>{status.urgent.staleClaims} réservation{status.urgent.staleClaims > 1 ? "s" : ""} abandonnée{status.urgent.staleClaims > 1 ? "s" : ""} (arrêt probable du serveur) : rapprochée{status.urgent.staleClaims > 1 ? "s" : ""} de l&apos;état réel de Buffer par le traitement urgent.</li>}
              <li className="text-xs text-muted-foreground">
                Traitement urgent : {status.urgent.lastRunAt ? `dernier passage ${formatRelative(status.urgent.lastRunAt, now)}${status.urgent.lastRunOk === false ? ` — en échec${status.urgent.lastRunError ? ` : ${status.urgent.lastRunError}` : ""}` : ""}` : "jamais exécuté"}.
              </li>
            </ul>
          </div>
        )}
        {status.anomalies.length > 0 && (
          <ul className="mt-4 grid gap-1.5 border-t pt-4" data-testid="sync-anomalies">
            {status.anomalies.map((anomaly) => (
              <li key={anomaly} className="flex items-start gap-2 text-sm text-tone-amber">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {anomaly}
              </li>
            ))}
          </ul>
        )}
        {overQuota && (
          <p className="mt-4 flex items-start gap-2 border-t pt-4 text-sm text-tone-amber">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Une synchronisation toutes les {intervalMinutes} minutes consomme environ {monthlyRequests(intervalMinutes).toLocaleString("fr-FR")} requêtes par mois, plus que le quota
            de ce compte Buffer ({Number(monthlyQuota).toLocaleString("fr-FR")}). Les exécutions planifiées se mettront en pause avant de l&apos;épuiser : allongez l&apos;intervalle.
          </p>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-card p-5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Source</p>
          <p className="mt-2 font-semibold">{mode === "real" ? "Buffer (API réelle)" : "Buffer simulé"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "real" ? "Les publications proviennent de votre compte Buffer." : "Données fictives : aucun appel à Buffer n'est effectué."}
          </p>
        </div>
        <div className="rounded-2xl border bg-card p-5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Soumission au client</p>
          <p className="mt-2 font-semibold">Tag Buffer « {reviewTag} »</p>
          <p className="mt-1 text-sm text-muted-foreground">Un brouillon portant ce tag est proposé au client du canal concerné.</p>
        </div>
        <div className="rounded-2xl border bg-card p-5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Quota de requêtes Buffer restant</p>
          {lastQuota ? (
            <ul className="mt-2 grid gap-0.5 text-sm">
              {Object.entries(lastQuota).map(([window, remaining]) => (
                <li key={window} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{QUOTA_LABELS[window] ?? window}</span>
                  <span className="font-semibold tabular-nums">{remaining}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{mode === "real" ? "Inconnu avant la première synchronisation." : "Sans objet en mode simulé."}</p>
          )}
        </div>
      </div>

      <section aria-labelledby="runs-title">
        <h2 id="runs-title" className="mb-3 font-display text-xl font-medium">
          Journal
        </h2>
        {runs.length === 0 ? (
          <p className="rounded-2xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Aucune synchronisation enregistrée.</p>
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-card" data-testid="sync-runs">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-start gap-3 border-b px-4 py-3 text-sm last:border-b-0">
                {run.status === "success" ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-tone-green" aria-label="Réussie" />
                ) : (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-tone-red" aria-label="En échec" />
                )}
                <span className="w-40 shrink-0 tabular-nums">{formatDateTime(run.createdAt, DEFAULT_TIMEZONE)}</span>
                <span className="w-24 shrink-0 text-muted-foreground">{run.triggeredBy}</span>
                <span className="min-w-0 flex-1 basis-64 text-muted-foreground">
                  {run.status === "error" ? (
                    <span className="text-tone-red">{run.error}</span>
                  ) : (
                    `${run.fetched} lus · ${run.created} nouveaux · ${run.updated} mis à jour · ${run.invalidated} validations annulées · ${run.removed} supprimés`
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="rounded-2xl border border-dashed p-4 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Automatiser :</span> Buffer ne prévient d&apos;aucun changement, il faut donc l&apos;interroger
        régulièrement. Le planificateur appelle <code className="font-mono text-xs">POST /api/automation/sync</code> toutes les {intervalMinutes} minutes ; son
        activation est décrite dans <code className="font-mono text-xs">docs/PLANIFICATEUR.md</code>. Deux déclenchements simultanés ne se gênent pas : un seul s&apos;exécute.
      </p>
    </div>
  );
}
