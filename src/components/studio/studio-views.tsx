"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, DatabaseZap, Images, PenLine, Plus } from "lucide-react";
import { toast } from "sonner";

import { NetworkIcon } from "@/components/shared/network-icon";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { EmptyState, PageHeader } from "@/components/shared/page-header";
import { TONE_CLASSES } from "@/components/shared/status-badge";
import { matchesOrgFilter, useAdmin } from "@/components/shell/admin-context";
import { MediaLibrary } from "@/components/studio/media-library";
import { Button } from "@/components/ui/button";
import { leaveIfExpired } from "@/lib/action-result";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { Tone } from "@/lib/domain/status";
import { toNetwork, type Channel, type MediaAsset, type Organization, type StudioDraft } from "@/lib/types";
import { DEFAULT_TIMEZONE } from "@/lib/view";
import { cn } from "@/lib/utils";
import { setStudioDraftArchived } from "@/server/studio-actions";

/** État d'un contenu, vu du Studio. */
export function draftState(draft: StudioDraft): { label: string; tone: Tone } {
  if (draft.status === "archived") return { label: "Archivé", tone: "neutral" };
  if (draft.variants.some((variant) => variant.pushState === "unknown")) return { label: "État Buffer incertain", tone: "amber" };
  if (draft.variants.some((variant) => variant.pushState === "failed")) return { label: "Échec d'envoi", tone: "red" };
  const sent = draft.variants.filter((variant) => variant.bufferPostId);
  if (sent.length === 0) return { label: "Brouillon", tone: "neutral" };
  if (sent.length < draft.variants.length || sent.some((variant) => variant.pushedRevision !== draft.revision)) return { label: "Modifications non envoyées", tone: "amber" };
  return { label: "Envoyé en validation", tone: "green" };
}

export function MigrationNeeded() {
  return (
    <EmptyState
      icon={DatabaseZap}
      title="Le Studio n'est pas encore activé"
      description="La base de données n'a pas reçu la migration 0008. La marche à suivre est dans docs/STUDIO.md."
    />
  );
}

/** Choix du client pour un nouveau contenu. */
export function NewDraftChooser({ organizations }: { organizations: Organization[] }) {
  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="Nouveau contenu" description="Pour quel client ? Le client ne change plus ensuite : ses canaux et sa bibliothèque de médias en dépendent." />
      {organizations.length === 0 ? (
        <EmptyState icon={PenLine} title="Aucun client" description="Créez d'abord un client et rattachez-lui un canal Buffer." action={<Button asChild size="lg"><Link href="/admin/clients">Ouvrir les clients</Link></Button>} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                href={`/admin/studio/nouveau?client=${organization.id}`}
                className="flex items-center gap-3 rounded-2xl border bg-card p-4 outline-none transition-shadow hover:shadow-soft focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <OrgAvatar organization={organization} />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{organization.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">{organization.sector || "Client"}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StudioList({ drafts, channels, now }: { drafts: StudioDraft[]; channels: Channel[]; now: string }) {
  const router = useRouter();
  const { orgFilter, organizations } = useAdmin();
  const scoped = drafts.filter((draft) => matchesOrgFilter(orgFilter, draft.organizationId));
  const active = scoped.filter((draft) => draft.status !== "archived");
  const archived = scoped.filter((draft) => draft.status === "archived");
  const selected = organizations.find((organization) => organization.id === orgFilter);

  const archive = async (draft: StudioDraft, value: boolean) => {
    const result = await setStudioDraftArchived({ id: draft.id, archived: value });
    if (leaveIfExpired(result)) return;
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
    router.refresh();
  };

  const row = (draft: StudioDraft) => {
    const organization = organizations.find((item) => item.id === draft.organizationId);
    const state = draftState(draft);
    const firstText = draft.variants.find((variant) => variant.text.trim())?.text.split("\n")[0] ?? "";
    return (
      <li key={draft.id} className="flex items-center gap-3 border-b px-3 py-3 last:border-b-0 sm:gap-4 sm:px-4">
        <Link href={`/admin/studio/${draft.id}`} data-draft={draft.id} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:gap-4">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{draft.title || firstText || "Contenu sans titre"}</span>
            <span className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
              {organization && <OrgAvatar organization={organization} size="sm" className="size-4 rounded-[4px] text-[8px]" />}
              <span className="truncate">{organization?.name ?? "Client archivé"}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">modifié {formatRelative(draft.updatedAt, now)}</span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 max-sm:hidden">
            {draft.variants.map((variant) => {
              const channel = channels.find((item) => item.id === variant.channelId);
              return channel ? <NetworkIcon key={variant.id} network={toNetwork(channel.service)} size="xs" /> : null;
            })}
          </span>
          <span className="hidden w-36 shrink-0 text-sm text-muted-foreground tabular-nums lg:block">
            {draft.dueAt ? formatDateTime(draft.dueAt, organization?.timezone ?? DEFAULT_TIMEZONE) : "Sans date"}
          </span>
          <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium", TONE_CLASSES[state.tone].badge)}>
            <span className={cn("size-1.5 rounded-full", TONE_CLASSES[state.tone].dot)} aria-hidden="true" />
            {state.label}
          </span>
        </Link>
        <button
          type="button"
          onClick={() => void archive(draft, draft.status !== "archived")}
          aria-label={draft.status === "archived" ? "Restaurer ce contenu" : "Archiver ce contenu"}
          title={draft.status === "archived" ? "Restaurer" : "Archiver"}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {draft.status === "archived" ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        </button>
      </li>
    );
  };

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader
        title="Studio"
        description={selected ? `Les contenus préparés pour ${selected.name}.` : "Préparez vos contenus ici, puis envoyez-les en validation. Buffer se charge de publier, après l'accord du client."}
        actions={
          <>
            <Button asChild variant="outline" size="lg">
              <Link href="/admin/studio/medias">
                <Images /> Médias
              </Link>
            </Button>
            <Button asChild size="lg">
              <Link href={selected ? `/admin/studio/nouveau?client=${selected.id}` : "/admin/studio/nouveau"}>
                <Plus /> Nouveau contenu
              </Link>
            </Button>
          </>
        }
      />
      {active.length === 0 ? (
        <EmptyState
          icon={PenLine}
          title="Aucun contenu en préparation"
          description="Rédigez un texte par réseau, ajoutez vos visuels, choisissez la date : le client validera depuis son espace."
          action={
            <Button asChild size="lg">
              <Link href={selected ? `/admin/studio/nouveau?client=${selected.id}` : "/admin/studio/nouveau"}>
                <Plus /> Nouveau contenu
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-2xl border bg-card" data-testid="studio-drafts">
          {active.map(row)}
        </ul>
      )}
      {archived.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            {archived.length} contenu{archived.length > 1 ? "s" : ""} archivé{archived.length > 1 ? "s" : ""}
          </summary>
          <ul className="mt-3 overflow-hidden rounded-2xl border bg-card">{archived.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

/** Bibliothèques de médias, une par client. Le client affiché suit le sélecteur de l'en-tête. */
export function MediaPage({ media }: { media: MediaAsset[] }) {
  const { orgFilter, organizations, setOrgFilter } = useAdmin();
  const organization = organizations.find((item) => item.id === orgFilter) ?? null;

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="Médias" description="Une bibliothèque par client, privée : seuls vous et Buffer (au moment de l'envoi) y accédez." />
      {!organization ? (
        <div className="grid grid-cols-1 gap-3">
          <p className="text-sm text-muted-foreground">Choisissez un client pour ouvrir sa bibliothèque.</p>
          <ul className="flex flex-wrap gap-2">
            {organizations.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setOrgFilter(item.id)}
                  className="flex h-10 items-center gap-2 rounded-xl border bg-card px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <OrgAvatar organization={item} size="sm" />
                  {item.name}
                  <span className="text-xs text-muted-foreground tabular-nums">{media.filter((asset) => asset.organizationId === item.id && !asset.archivedAt).length}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <MediaLibrary organizationId={organization.id} media={media.filter((asset) => asset.organizationId === organization.id)} />
      )}
    </div>
  );
}
