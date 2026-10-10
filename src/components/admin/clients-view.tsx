"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, ArrowRight, Building2, Inbox, Plus, Search, TriangleAlert } from "lucide-react";

import { ChannelRow } from "@/components/admin/channel-row";
import { ClientFormDialog } from "@/components/admin/client-form-dialog";
import { NetworkIcon } from "@/components/shared/network-icon";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { EmptyState, PageHeader } from "@/components/shared/page-header";
import { SyncButton } from "@/components/shell/sync-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isArchived, matchesClientSearch, sortChannels } from "@/lib/domain/clients";
import { toNetwork, type Channel, type Organization } from "@/lib/types";
import type { PostView } from "@/lib/view";
import { cn } from "@/lib/utils";

/** Administration → Clients : les clients, leurs réseaux, et l'attribution de chaque canal Buffer. */
export function ClientsView({
  organizations,
  channels,
  posts,
  members,
}: {
  organizations: Organization[];
  channels: Channel[];
  posts: PostView[];
  members: { organizationId: string; userId: string }[];
}) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const archivedCount = organizations.filter(isArchived).length;
  const unassigned = channels.filter((channel) => !channel.organizationId);
  const channelsOf = (organization: Organization) => channels.filter((channel) => channel.organizationId === organization.id);
  const visible = organizations.filter((organization) => isArchived(organization) === showArchived && matchesClientSearch(organization, channelsOf(organization), query));
  const postCount = (channel: Channel) => posts.filter((post) => post.channelId === channel.id).length;

  return (
    <div className="grid animate-rise grid-cols-1 gap-8">
      <PageHeader
        title="Clients"
        description="Chaque canal Buffer est attribué à un client : c'est ce lien qui détermine ce que le client voit et valide."
        actions={
          <Button size="lg" onClick={() => setCreating(true)}>
            <Plus />
            Nouveau client
          </Button>
        }
      />

      {unassigned.length > 0 && (
        <a href="#canaux" className="flex items-start gap-3 rounded-2xl border border-tone-amber/30 bg-tone-amber-soft px-4 py-3 text-sm text-tone-amber outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">
              {unassigned.length} canal{unassigned.length > 1 ? "aux" : ""} sans client.
            </span>{" "}
            Leurs publications ne sont visibles d&apos;aucun client tant qu&apos;ils ne sont pas attribués.
          </span>
        </a>
      )}

      <section aria-labelledby="clients-title" className="grid grid-cols-1 gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="clients-title" className="sr-only">
            Liste des clients
          </h2>
          <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un client ou un canal" aria-label="Rechercher un client" className="h-9 bg-card pl-8" />
          </div>
          {archivedCount > 0 && (
            <div className="flex rounded-lg border bg-card p-0.5 text-sm" role="group" aria-label="Filtrer les clients">
              {[
                { archived: false, label: `Actifs (${organizations.length - archivedCount})` },
                { archived: true, label: `Archivés (${archivedCount})` },
              ].map((tab) => (
                <button
                  key={tab.label}
                  type="button"
                  aria-pressed={showArchived === tab.archived}
                  onClick={() => setShowArchived(tab.archived)}
                  className={cn("rounded-md px-3 py-1.5 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50", showArchived === tab.archived ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={showArchived ? Archive : Building2}
            title={query ? "Aucun client ne correspond" : showArchived ? "Aucun client archivé" : "Aucun client"}
            description={query ? "Modifiez votre recherche." : showArchived ? undefined : "Créez votre premier client, puis attribuez-lui ses canaux."}
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {visible.map((organization) => {
              const orgChannels = channelsOf(organization);
              const memberCount = members.filter((member) => member.organizationId === organization.id).length;
              const pending = posts.filter((post) => post.organization?.id === organization.id && post.status === "pending_approval").length;
              return (
                <Link
                  key={organization.id}
                  href={`/admin/clients/${organization.id}`}
                  data-org={organization.slug}
                  className="group flex flex-col rounded-2xl border bg-card p-5 outline-none transition-all hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-3 focus-visible:ring-ring/50 sm:p-6"
                >
                  <div className="flex items-start gap-4">
                    <OrgAvatar organization={organization} size="lg" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-display text-xl font-medium">{organization.name}</h3>
                      <p className="truncate text-sm text-muted-foreground">{organization.sector || "Secteur non renseigné"}</p>
                    </div>
                    <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    {orgChannels.length === 0 && <span className="text-sm text-tone-amber">Aucun canal attribué</span>}
                    {orgChannels.map((channel) => (
                      <span key={channel.id} className="flex max-w-full items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1 text-xs font-medium">
                        <NetworkIcon network={toNetwork(channel.service)} size="sm" className="rounded-full" />
                        <span className="truncate">{channel.displayName || channel.name}</span>
                      </span>
                    ))}
                  </div>
                  <p className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t pt-4 text-sm text-muted-foreground">
                    <span>
                      {memberCount} utilisateur{memberCount > 1 ? "s" : ""}
                    </span>
                    <span className={cn(pending > 0 && "font-medium text-tone-amber")}>{pending === 0 ? "Aucune validation en attente" : `${pending} en attente de validation`}</span>
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="canaux-title" id="canaux" className="scroll-mt-24">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="canaux-title" className="font-display text-xl font-medium">
              Canaux Buffer
            </h2>
            <p className="text-sm text-muted-foreground">Comptes sociaux connectés dans Buffer. L&apos;attribution ne change rien dans Buffer.</p>
          </div>
          <SyncButton label="Actualiser depuis Buffer" />
        </div>
        {channels.length === 0 ? (
          <EmptyState icon={Inbox} title="Aucun canal" description="Lancez une synchronisation pour récupérer vos canaux Buffer." action={<SyncButton variant="default" />} />
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-card">
            {sortChannels(channels).map((channel) => (
              <ChannelRow key={channel.id} channel={channel} organizations={organizations} postCount={postCount(channel)} />
            ))}
          </ul>
        )}
      </section>

      {creating && <ClientFormDialog open onOpenChange={setCreating} />}
    </div>
  );
}
