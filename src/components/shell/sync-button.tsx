"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { syncNow } from "@/server/actions";

function summarize(result: Awaited<ReturnType<typeof syncNow>>): string {
  const parts = [`${result.fetched} post${result.fetched > 1 ? "s" : ""} lu${result.fetched > 1 ? "s" : ""} dans Buffer`];
  if (result.created) parts.push(`${result.created} nouveau${result.created > 1 ? "x" : ""}`);
  if (result.invalidated) parts.push(`${result.invalidated} validation${result.invalidated > 1 ? "s" : ""} annulée${result.invalidated > 1 ? "s" : ""}`);
  if (result.scheduled) parts.push(`${result.scheduled} programmé${result.scheduled > 1 ? "s" : ""}`);
  if (result.unscheduled) parts.push(`${result.unscheduled} déprogrammé${result.unscheduled > 1 ? "s" : ""}`);
  if (result.removed) parts.push(`${result.removed} supprimé${result.removed > 1 ? "s" : ""}`);
  if (result.scheduleFailures) parts.push(`${result.scheduleFailures} échec${result.scheduleFailures > 1 ? "s" : ""} de programmation`);
  return parts.join(" · ");
}

/** Lit Buffer maintenant, met le dashboard à jour et programme les posts approuvés. */
export function SyncButton({ variant = "outline", label = "Synchroniser" }: { variant?: "outline" | "default"; label?: string }) {
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      const result = await syncNow();
      if (result.ok) toast.success("Synchronisation terminée", { description: summarize(result) });
      else toast.error("Synchronisation impossible", { description: result.error });
    });

  return (
    <Button variant={variant} size="lg" onClick={run} disabled={pending} className="shrink-0 max-sm:size-9 max-sm:px-0">
      <RefreshCw className={cn(pending && "animate-spin")} />
      <span className="max-sm:sr-only">{pending ? "Synchronisation…" : label}</span>
    </Button>
  );
}
