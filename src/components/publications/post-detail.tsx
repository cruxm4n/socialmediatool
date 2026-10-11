import Link from "next/link";
import { ArrowLeft, Ban, CircleCheckBig, CircleDot, Clock, ExternalLink, MessageSquareWarning, PenLine, Rocket, Trash2 } from "lucide-react";

import { ActivityTimeline } from "@/components/publications/activity";
import { CommentThread } from "@/components/publications/comments";
import { AlertList, Panel, PostContent, StatusBanner, VersionHistory } from "@/components/publications/post-panels";
import { OwnerAssign } from "@/components/publications/owner-assign";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDateTime } from "@/lib/dates";
import { bufferUrl } from "@/lib/domain/inbox";
import { getPostAlerts } from "@/lib/domain/status";
import type { Comment, Organization, PostEvent, PostVersion, Profile } from "@/lib/types";
import type { PostView } from "@/lib/view";

/** Fiche d'une publication côté administrateur : état, contenu, échanges et historique. */
export function PostDetail({
  post,
  comments,
  events,
  profiles,
  now,
  reviewTag,
  versions = [],
  organizations = [],
}: {
  post: PostView;
  comments: Comment[];
  events: PostEvent[];
  profiles: Profile[];
  now: string;
  reviewTag: string;
  versions?: PostVersion[];
  /** Clients actifs : sert à attribuer une publication importée de façon ambiguë. */
  organizations?: Organization[];
}) {
  const alerts = getPostAlerts(post, now);
  if (post.channel?.isDisconnected) {
    alerts.unshift({ level: "error", message: "Le canal de cette publication est déconnecté dans Buffer : reconnectez-le, sinon rien ne pourra être publié." });
  }
  const bufferLink = post.removedAt ? null : bufferUrl(post, post.channel?.bufferChannelId);
  const approver = profiles.find((profile) => profile.id === post.approvedById);
  const lastRequest = [...comments].reverse().find((comment) => comment.kind === "change_request");
  const requester = profiles.find((profile) => profile.id === lastRequest?.authorId);

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <div>
        <Link
          href="/admin/publications"
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-4" /> Publications
        </Link>
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          {post.organization ? (
            <>
              <OrgAvatar organization={post.organization} size="sm" />
              {post.organization.name}
            </>
          ) : (
            <span className="font-medium text-tone-amber">Canal non rattaché à un client</span>
          )}
          <span aria-hidden="true">·</span>
          <span>Version {post.version}</span>
        </p>
        <h1 className="mt-2 font-display text-[1.6rem] leading-tight font-medium sm:text-[1.9rem]">{post.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge status={post.status} />
          {bufferLink && (
            <a
              href={bufferLink}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="buffer-link"
              title="Ouvre le canal de cette publication dans Buffer, sur le bon onglet."
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ExternalLink className="size-3.5" /> Ouvrir dans Buffer
            </a>
          )}
        </div>
      </div>

      {post.removedAt && (
        <StatusBanner tone="neutral" icon={Trash2} title="Supprimée dans Buffer">
          Cette publication n&apos;existe plus dans Buffer depuis le {formatDateTime(post.removedAt, post.timezone)}. Elle n&apos;est plus visible du
          client ; son historique est conservé ici.
        </StatusBanner>
      )}

      {!post.removedAt && post.ownership === "ambiguous" && (
        <StatusBanner tone="amber" icon={CircleDot} title="Appartenance à confirmer">
          Cette publication a été importée depuis un canal transféré ou détaché : on ne peut pas savoir à quel client elle appartient. Elle
          reste visible de vous seul, sans validation possible, tant que vous ne l&apos;avez pas attribuée.
          <div className="mt-3">
            <OwnerAssign postId={post.id} organizations={organizations} />
          </div>
        </StatusBanner>
      )}

      <AlertList alerts={post.removedAt ? [] : alerts} />

      {!post.removedAt && post.status === "draft" && (
        <StatusBanner tone="neutral" icon={PenLine} title="Brouillon non soumis au client">
          Pour le soumettre à validation, ajoutez le tag {reviewTag} à ce brouillon dans Buffer, puis synchronisez.
          {!post.organization && " Rattachez aussi son canal à un client (page Clients), sinon personne ne pourra le valider."}
        </StatusBanner>
      )}
      {!post.removedAt && post.status === "pending_approval" && (
        <StatusBanner tone="amber" icon={Clock} title={`En attente de la décision de ${post.organization?.name ?? "votre client"}`}>
          Version {post.version}
          {post.submittedAt && ` soumise le ${formatDateTime(post.submittedAt, post.timezone)}`}. Toute modification dans Buffer créera une
          nouvelle version à valider.
          {!post.organization && " Attention : ce canal n'est rattaché à aucun client, personne ne peut donc valider."}
        </StatusBanner>
      )}
      {!post.removedAt && post.status === "changes_requested" && (
        <StatusBanner tone="rose" icon={MessageSquareWarning} title="Le client demande des modifications">
          {lastRequest && (
            <blockquote className="mt-1 border-l-2 border-tone-rose/40 pl-3 text-foreground italic">
              « {lastRequest.body} » — {requester?.fullName ?? "Client"}
            </blockquote>
          )}
          <p className="mt-2">
            Modifiez le brouillon dans Buffer : la nouvelle version sera soumise automatiquement à la prochaine synchronisation.
          </p>
        </StatusBanner>
      )}
      {!post.removedAt && post.status === "approved" && (
        <StatusBanner tone="green" icon={CircleCheckBig} title={`Version ${post.approvedVersion} approuvée`}>
          {approver && post.approvedAt && `Par ${approver.fullName}, ${formatDateTime(post.approvedAt, post.timezone)}. `}
          En attente de programmation dans Buffer.
        </StatusBanner>
      )}
      {!post.removedAt && post.status === "scheduled" && post.approvalStatus === "approved" && (
        <StatusBanner tone="blue" icon={CircleDot} title="Programmée dans Buffer">
          {approver && post.approvedAt && `Version ${post.approvedVersion} approuvée par ${approver.fullName}, ${formatDateTime(post.approvedAt, post.timezone)}. `}
          Buffer la publiera à la date prévue. Si vous la modifiez dans Buffer, elle repassera en brouillon et devra être validée à nouveau.
        </StatusBanner>
      )}
      {post.status === "published" && (
        <StatusBanner tone="green" icon={Rocket} title="Publiée">
          {post.sentAt && `Publiée par Buffer le ${formatDateTime(post.sentAt, post.timezone)}.`}
        </StatusBanner>
      )}
      {!post.removedAt && post.status === "error" && (
        <StatusBanner tone="red" icon={Ban} title="Une erreur bloque cette publication">
          Le détail figure ci-dessus. Corrigez le problème dans Buffer, puis synchronisez.
        </StatusBanner>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <PostContent post={post} showTechnical />
        <div className="grid grid-cols-1 gap-6">
          <Panel title="Commentaires">
            <CommentThread postId={post.id} comments={comments} profiles={profiles} timezone={post.timezone} />
          </Panel>
          <Panel title="Historique">
            <ActivityTimeline events={events} profiles={profiles} timezone={post.timezone} />
          </Panel>
          {versions.length > 1 && (
            <Panel title="Versions du contenu">
              <VersionHistory versions={versions} current={post.version} timezone={post.timezone} />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
