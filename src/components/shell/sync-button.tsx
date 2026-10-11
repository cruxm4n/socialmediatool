"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { leaveIfExpired } from "@/lib/action-result";
import { useAdmin } from "@/components/shell/admin-context";
import { syncNow } from "@/server/actions";

/** Raison pour laquelle aucune lecture de Buffer n'est possible sur ce serveur, ou null. */
export function bufferUnavailable(mode: "real" | "mock", buffer: { accounts: number; problem: string | null }): string | null {
  if (mode === "mock") return null;
  if (buffer.problem) return buffer.problem;
  return buffer.accounts === 0 ? "Aucun compte Buffer connecté : connectez un compte dans Paramètres → Intégrations." : null;
}

function summarize(result: Awaited<ReturnType<typeof syncNow>>): string {
  const parts = [`${result.fetched} post${result.fetched > 1 ? "s" : ""} lu${result.fetched > 1 ? "s" : ""} dans Buffer`];
  if (result.created) parts.push(`${result.created} nouveau${result.created > 1 ? "x" : ""}`);
  if (result.invalidated) parts.push(`${result.invalidated} validation${result.invalidated > 1 ? "s" : ""} annulée${result.invalidated > 1 ? "s" : ""}`);
  if (result.scheduled) parts.push(`${result.scheduled} programmé${result.scheduled > 1 ? "s" : ""}`);
  if (result.unscheduled) parts.push(`${result.unscheduled} déprogrammé${result.unscheduled > 1 ? "s" : ""}`);
  if (result.removed) parts.push(`${result.removed} supprimé${result.removed > 1 ? "s" : ""}`);
  if (result.unscheduleFailures) parts.push(`${result.unscheduleFailures} échec${result.unscheduleFailures > 1 ? "s" : ""} de déprogrammation`);
  if (result.scheduleFailures) parts.push(`${result.scheduleFailures} échec${result.scheduleFailures > 1 ? "s" : ""} de programmation`);
  return parts.join(" · ");
}

/** Lit Buffer maintenant, met le dashboard à jour et programme les posts approuvés. */
export function SyncButton({ variant = "outline", label = "Synchroniser" }: { variant?: "outline" | "default"; label?: string }) {
  const [pending, startTransition] = useTransition();
  const { mode, buffer } = useAdmin();
  // Sans compte Buffer utilisable, il n'y a rien à lire : le bouton est désactivé et dit pourquoi.
  const unavailable = bufferUnavailable(mode, buffer);

  const run = () =>
    startTransition(async () => {
      try {
        const result = await syncNow();
        if (leaveIfExpired(result)) return;
        if (result.skipped) toast.info("Synchronisation non lancée", { description: result.error });
        else if (result.ok) toast.success("Synchronisation terminée", { description: summarize(result) });
        else toast.error("Synchronisation incomplète", { description: `${result.error} ${summarize(result)}` });
      } catch {
        toast.error("Synchronisation impossible", { description: "La connexion a été interrompue. Consultez le journal avant de réessayer." });
      }
    });

  return (
    <Button variant={variant} size="lg" onClick={run} disabled={pending || unavailable !== null} title={unavailable ?? undefined} className="shrink-0 max-sm:size-9 max-sm:px-0">
      <RefreshCw className={cn(pending && "animate-spin")} />
      <span className="max-sm:sr-only">{pending ? "Synchronisation…" : label}</span>
    </Button>
  );
}

/** Au-delà de ce délai sans synchronisation, l'ouverture de l'espace admin en déclenche une. */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Tant qu'aucun planificateur (n8n, cron) n'est branché, c'est l'ouverture de l'espace admin
 * qui tient les données à jour. Silencieux, au plus une fois par chargement de l'application.
 */
export function AutoSync({ lastSyncAt, disabled = false }: { lastSyncAt: string | null; disabled?: boolean }) {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (disabled) return; // aucun compte Buffer utilisable : rien à lire
    if (started.current || !lastSyncAt) return; // jamais synchronisé : l'admin lance la première lui-même
    if (Date.now() - Date.parse(lastSyncAt) < STALE_AFTER_MS) return;
    started.current = true;
    void syncNow().then((result) => {
      if (leaveIfExpired(result)) return;
      router.refresh();
      if (!result.ok && !result.skipped) toast.error("Synchronisation automatique incomplète", { description: result.error });
    }).catch(() => {
      toast.error("Synchronisation automatique impossible", { description: "Vérifiez la connexion et consultez le journal." });
    });
  }, [lastSyncAt, router, disabled]);

  return null;
}
