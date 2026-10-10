"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { leaveIfExpired } from "@/lib/action-result";
import type { Organization } from "@/lib/types";
import { setPostOwner } from "@/server/actions";

/**
 * Attribution d'une publication importée de façon ambiguë (canal transféré ou détaché).
 * Tant qu'elle n'est pas attribuée, seul l'administrateur la voit.
 */
export function OwnerAssign({ postId, organizations }: { postId: string; organizations: Organization[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const active = organizations.filter((organization) => organization.archivedAt === null);
  const [target, setTarget] = useState(active[0]?.id ?? "");

  const assign = () =>
    start(async () => {
      try {
        const result = await setPostOwner({ postIds: [postId], organizationId: target });
        if (leaveIfExpired(result)) return;
        if (result.ok) toast.success("Publication attribuée", { description: result.message });
        else toast.error("Attribution impossible", { description: result.message });
        router.refresh();
      } catch {
        toast.error("La confirmation n'a pas été reçue", { description: "Rechargez la page avant de réessayer." });
      }
    });

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="owner-assign">
      <label className="sr-only" htmlFor="owner-select">
        Client propriétaire de cette publication
      </label>
      <select
        id="owner-select"
        value={target}
        onChange={(event) => setTarget(event.target.value)}
        className="h-9 rounded-lg border bg-card px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {active.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
      <Button size="sm" disabled={pending || !target} onClick={assign}>
        Attribuer à ce client
      </Button>
    </div>
  );
}
