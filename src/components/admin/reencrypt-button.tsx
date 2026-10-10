"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { leaveIfExpired } from "@/lib/action-result";
import { reencryptCredentials } from "@/server/connection-actions";

/** Re-chiffre les clés Buffer avec la clé maître courante (rotation). Aucun appel à Buffer, aucune clé affichée. */
export function ReencryptButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = () =>
    startTransition(async () => {
      try {
        const result = await reencryptCredentials();
        if (leaveIfExpired(result)) return;
        if (result.ok) toast.success(result.message);
        else toast.error(result.message);
        router.refresh();
      } catch {
        toast.error("La connexion a été interrompue. Rechargez la page avant de réessayer.");
      }
    });
  return (
    <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={pending} onClick={run}>
      {pending ? "Re-chiffrement…" : "Re-chiffrer avec la clé courante"}
    </Button>
  );
}
