import Link from "next/link";
import { ArrowLeft, Ban, CircleCheckBig, CircleDot, Clock, MessageSquareWarning, PenLine, Rocket } from "lucide-react";

import { ActivityTimeline } from "@/components/publications/activity";
import { CommentThread } from "@/components/publications/comments";
import { AlertList, Panel, PostContent, StatusBanner } from "@/components/publications/post-panels";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDateTime } from "@/lib/dates";
import { getPostAlerts } from "@/lib/domain/status";
import type { Comment, PostEvent, Profile } from "@/lib/types";
import type { PostView } from "@/lib/view";

/** Fiche d'une publication côté administrateur : état, contenu, échanges et historique. */
export function PostDetail({
  post,
  comments,
  events,
  profiles,
  now,
  reviewTag,
}: {
  post: PostView;
  comments: Comment[];
  events: PostEvent[];
  profiles: Profile[];
  now: string;
  reviewTag: string;
}) {
  const alerts = getPostAlerts(post, now);
  const approver = profiles.find((profile) => profile.id === post.approvedById);
  const lastRequest = [...comments].reverse().find((comment) => comment.kind === "change_request");
  const requester = profiles.find((profile) => profile.id === lastRequest?.authorId);

  return (
    <div className="grid animate-rise gap-6">
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
        <div className="mt-3">
          <StatusBadge status={post.status} />
        </div>
      </div>

      <AlertList alerts={alerts} />

      {post.status === "draft" && (
        <StatusBanner tone="neutral" icon={PenLine} title="Brouillon non soumis au client">
          Pour le soumettre à validation, ajoutez le tag « {reviewTag} » à ce brouillon dans Buffer, puis synchronisez.
          {!post.organization && " Rattachez aussi son canal à un client (page Clients), sinon personne ne pourra le valider."}
        </StatusBanner>
      )}
      {post.status === "pending_approval" && (
        <StatusBanner tone="amber" icon={Clock} title={`En attente de la décision de ${post.organization?.name ?? "votre client"}`}>
          Version {post.version}
          {post.submittedAt && ` soumise le ${formatDateTime(post.submittedAt, post.timezone)}`}. Toute modification dans Buffer créera une
          nouvelle version à valider.
          {!post.organization && " Attention : ce canal n'est rattaché à aucun client, personne ne peut donc valider."}
        </StatusBanner>
      )}
      {post.status === "changes_requested" && (
        <StatusBanner tone="rose" icon={MessageSquareWarning} title="Le client demande des modifications">
          {lastRequest && (
            <blockquote className="mt-1 border-l-2 border-tone-rose/40 pl-3 text-foreground italic">
              « {lastRequest.body} » — {requester?.fullName ?? "Client"}
            </blockquote>
          )}
          <p className="mt-2">Modifiez le brouillon dans Buffer : la nouvelle version sera soumise automatiquement à la prochaine synchronisation.</p>
        </StatusBanner>
      )}
      {post.status === "approved" && (
        <StatusBanner tone="green" icon={CircleCheckBig} title={`Version ${post.approvedVersion} approuvée`}>
          {approver && post.approvedAt && `Par ${approver.fullName}, ${formatDateTime(post.approvedAt, post.timezone)}. `}
          En attente de programmation dans Buffer.
        </StatusBanner>
      )}
      {post.status === "scheduled" && post.approvalStatus === "approved" && (
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
      {post.status === "error" && (
        <StatusBanner tone="red" icon={Ban} title="Une erreur bloque cette publication">
          Le détail figure ci-dessus. Corrigez le problème dans Buffer, puis synchronisez.
        </StatusBanner>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <PostContent post={post} showTechnical />
        <div className="grid gap-6">
          <Panel title="Commentaires">
            <CommentThread postId={post.id} comments={comments} profiles={profiles} timezone={post.timezone} />
          </Panel>
          <Panel title="Historique">
            <ActivityTimeline events={events} profiles={profiles} timezone={post.timezone} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
