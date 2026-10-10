"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { NetworkIcon } from "@/components/shared/network-icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { leaveIfExpired } from "@/lib/action-result";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { toNetwork, type Channel, type Organization } from "@/lib/types";
import { assignChannel } from "@/server/actions";

const UNASSIGNED = "none";
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });

/**
 * Un canal Buffer et le client auquel il est attribué. Changer la valeur rattache, détache ou
 * transfère le canal dans Cadence uniquement : rien n'est modifié dans Buffer.
 */
export function ChannelRow({ channel, organizations, postCount }: { channel: Channel; organizations: Organization[]; postCount: number }) {
  const [pending, startTransition] = useTransition();
  const [transferTo, setTransferTo] = useState<Organization | null>(null);
  const network = toNetwork(channel.service);
  const label = channel.displayName || channel.name;
  const active = organizations.filter((organization) => organization.archivedAt === null);
  const current = organizations.find((organization) => organization.id === channel.organizationId);
  const options = current && current.archivedAt !== null ? [current, ...active] : active;

  const assign = (organizationId: string | null, confirmTransfer = false) =>
    startTransition(async () => {
      try {
        const result = await assignChannel({ channelId: channel.id, organizationId, confirmTransfer });
        if (leaveIfExpired(result)) return;
        if (result.needsConfirmation) {
          setTransferTo(organizations.find((organization) => organization.id === organizationId) ?? null);
          return;
        }
        setTransferTo(null);
        if (result.ok) toast.success(result.message);
        else toast.error(result.message);
      } catch {
        toast.error("La connexion a été interrompue. Rechargez la page pour vérifier l'attribution.");
      }
    });

  return (
    <li className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0" data-channel={channel.bufferChannelId}>
      <NetworkIcon network={network} size="md" />
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium">{label}</span>
          {!channel.organizationId && <span className="rounded-full bg-tone-amber-soft px-2 py-0.5 text-[11px] font-medium text-tone-amber">À attribuer</span>}
          {channel.isDisconnected && <span className="rounded-full bg-tone-red-soft px-2 py-0.5 text-[11px] font-medium text-tone-red">Déconnecté dans Buffer</span>}
        </span>
        <span className="block text-xs text-muted-foreground">
          {NETWORK_LABELS[network]} · {postCount} publication{postCount > 1 ? "s" : ""} · <span className="font-mono">ID {channel.bufferChannelId}</span>
        </span>
        {channel.visibleFrom && channel.organizationId && (
          <span className="block text-xs text-muted-foreground">Transféré le {dateFormat.format(new Date(channel.visibleFrom))} : l&apos;historique antérieur est masqué pour ce client.</span>
        )}
      </span>
      <Select value={channel.organizationId ?? UNASSIGNED} onValueChange={(value) => assign(value === UNASSIGNED ? null : value)} disabled={pending}>
        <SelectTrigger className="h-9! w-56 max-w-full bg-card" aria-label={`Client du canal ${label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>Non rattaché</SelectItem>
          {options.map((organization) => (
            <SelectItem key={organization.id} value={organization.id} disabled={organization.archivedAt !== null}>
              {organization.name}
              {organization.archivedAt !== null && " (archivé)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ConfirmDialog
        open={transferTo !== null}
        onOpenChange={(open) => !open && setTransferTo(null)}
        title={`Transférer « ${label} » à ${transferTo?.name ?? ""} ?`}
        confirmLabel="Transférer le canal"
        phrase={label}
        pending={pending}
        onConfirm={() => transferTo && assign(transferTo.id, true)}
      >
        <p>Ce canal a déjà appartenu à un autre client et porte des publications.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Les publications déjà présentes, leurs commentaires et leurs décisions resteront <strong>invisibles pour {transferTo?.name}</strong>. Vous continuez à les voir.
          </li>
          <li>L&apos;ancien client n&apos;aura plus accès à ce canal.</li>
          <li>Seules les publications qui apparaîtront à partir de maintenant seront soumises à {transferTo?.name}.</li>
          <li>Rien n&apos;est modifié dans Buffer.</li>
        </ul>
      </ConfirmDialog>
    </li>
  );
}
