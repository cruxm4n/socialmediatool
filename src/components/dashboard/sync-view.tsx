import { CircleCheck, CircleX } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { SyncButton } from "@/components/shell/sync-button";
import { formatDateTime } from "@/lib/dates";
import type { SyncRun } from "@/lib/types";
import { DEFAULT_TIMEZONE } from "@/lib/view";

const QUOTA_LABELS: Record<string, string> = {
  "100-in-15min": "sur 15 minutes",
  "250-in-1day": "sur 24 heures",
  "500-in-1day": "sur 24 heures",
  "3000-in-30days": "sur 30 jours",
  "15000-in-30days": "sur 30 jours",
};

export function SyncView({ runs, mode, reviewTag }: { runs: SyncRun[]; mode: "real" | "mock"; reviewTag: string }) {
  const lastQuota = runs.find((run) => run.rateLimit)?.rateLimit;

  return (
    <div className="grid animate-rise gap-6">
      <PageHeader
        title="Synchronisation"
        description="Chaque synchronisation lit Buffer, met à jour les publications, puis programme celles que le client a approuvées."
        actions={<SyncButton variant="default" label="Synchroniser maintenant" />}
      />

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
        <span className="font-medium text-foreground">Automatiser :</span> Buffer n&apos;envoie aucune notification, il faut donc l&apos;interroger
        régulièrement. Tant que n8n n&apos;est pas branché, la synchronisation se lance ici, ou par un appel planifié à{" "}
        <code className="font-mono text-xs">POST /api/automation/sync</code> (voir README).
      </p>
    </div>
  );
}
