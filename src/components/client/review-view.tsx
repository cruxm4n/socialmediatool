"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Ban, Check, CircleCheckBig, CircleDot, Clock, MessageSquareWarning, PenLine, Rocket } from "lucide-react";
import { toast } from "sonner";

import { ActivityTimeline } from "@/components/publications/activity";
import { CommentThread } from "@/components/publications/comments";
import { Panel, PostContent, StatusBanner, VersionHistory } from "@/components/publications/post-panels";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { canDecide, CLIENT_EVENT_TYPES, hasUsableDueDate } from "@/lib/domain/status";
import type { Comment, PostEvent, PostVersion, Profile } from "@/lib/types";
import type { PostView } from "@/lib/view";
import { leaveIfExpired, type ActionResult } from "@/lib/action-result";
import { approvePost, requestChanges } from "@/server/actions";

/** Écran de validation : le client relit la proposition puis décide. */
export function ReviewView({
  post,
  comments,
  events,
  profiles,
  basePath,
  now,
  nextPendingId,
  versions = [],
}: {
  post: PostView;
  comments: Comment[];
  events: PostEvent[];
  profiles: Profile[];
  basePath: string;
  now: string;
  /** Autre publication en attente, proposée une fois celle-ci traitée. */
  nextPendingId: string | null;
  versions?: PostVersion[];
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"approve" | "changes" | null>(null);
  const [changeBody, setChangeBody] = useState("");
  const [changeError, setChangeError] = useState(false);
  const [pending, startTransition] = useTransition();

  const decidable = canDecide(post);
  // Une publication dont la date est passée ne pourrait plus être programmée : l'approbation est fermée.
  const approvable = decidable && hasUsableDueDate(post, now);
  const approver = profiles.find((profile) => profile.id === post.approvedById);

  const finish = (result: ActionResult) => {
    if (leaveIfExpired(result)) return;
    setDialog(null);
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
    // Dans les deux cas, on relit l'état réel : un refus signifie souvent que la publication a changé.
    router.refresh();
  };

  // L'empreinte affichée part avec la décision : si le contenu a changé entre-temps, la base refuse.
  const approve = () =>
    startTransition(async () => {
      try {
        finish(await approvePost({ postId: post.id, expectedHash: post.contentHash }));
      } catch {
        toast.error("La confirmation n'a pas été reçue. Rechargez la publication pour vérifier son état avant de réessayer.");
      }
    });

  const sendChanges = () => {
    if (!changeBody.trim()) {
      setChangeError(true);
      return;
    }
    startTransition(async () => {
      try {
        const result = await requestChanges({ postId: post.id, expectedHash: post.contentHash, comment: changeBody });
        if (result.ok) setChangeBody("");
        finish(result);
      } catch {
        toast.error("La confirmation n'a pas été reçue. Votre demande est conservée ; vérifiez l'historique avant de réessayer.");
      }
    });
  };

  return (
    <div className="grid animate-rise grid-cols-1 gap-6 pb-24 sm:pb-0">
      <div>
        <Link
          href={decidable ? `${basePath}/a-valider` : `${basePath}/publications`}
          className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-4" /> {decidable ? "À valider" : "Publications"}
        </Link>
        <h1 className="mt-4 font-display text-[1.6rem] leading-tight font-medium sm:text-[1.9rem]">{post.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusBadge status={post.status} />
          <span className="text-xs text-muted-foreground">
            {NETWORK_LABELS[post.network]} · version {post.version}
          </span>
        </div>
      </div>

      {decidable && (
        <StatusBanner
          tone="amber"
          icon={Clock}
          title="Cette proposition attend votre décision"
          action={
            <div className="hidden gap-2 sm:flex">
              <Button variant="outline" size="lg" className="bg-card" onClick={() => setDialog("changes")}>
                <PenLine /> Demander des modifications
              </Button>
              <Button size="lg" onClick={() => setDialog("approve")} disabled={!approvable}>
                <Check /> Approuver
              </Button>
            </div>
          }
        >
          {approvable
            ? "Vérifiez le texte, le visuel et la date ci-dessous."
            : "La date prévue est absente ou dépassée : cette publication ne peut pas être approuvée en l'état. Demandez une modification pour que votre agence la reprogramme."}
        </StatusBanner>
      )}
      {!decidable && nextPendingId && (
        <Link
          href={`${basePath}/publications/${nextPendingId}`}
          className="flex items-center justify-between gap-3 rounded-2xl border bg-card px-4 py-3 text-sm font-semibold outline-none transition-shadow hover:shadow-soft focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Publication suivante à valider
          <ArrowRight className="size-4" />
        </Link>
      )}
      {post.status === "pending_approval" && !decidable && (
        <StatusBanner tone="neutral" icon={Clock} title="Validation momentanément indisponible">
          Votre agence est en train de modifier cette publication.
        </StatusBanner>
      )}
      {post.status === "changes_requested" && (
        <StatusBanner tone="rose" icon={MessageSquareWarning} title="Modifications demandées">
          Votre agence prépare une nouvelle version. Vous la retrouverez dans « À valider ».
        </StatusBanner>
      )}
      {post.status === "approved" && (
        <StatusBanner tone="green" icon={CircleCheckBig} title={`Version ${post.approvedVersion} approuvée`}>
          {approver && post.approvedAt && `Par ${approver.fullName}, ${formatDateTime(post.approvedAt, post.timezone)}. `}
          La programmation est en cours.
        </StatusBanner>
      )}
      {post.status === "scheduled" && (
        <StatusBanner tone="blue" icon={CircleDot} title="Programmée">
          {post.dueAt && `Elle sera publiée le ${formatDateTime(post.dueAt, post.timezone)}.`}
          {approver && ` Approuvée par ${approver.fullName}.`}
        </StatusBanner>
      )}
      {post.status === "published" && (
        <StatusBanner tone="green" icon={Rocket} title="Publiée">
          {post.sentAt && `Publiée le ${formatDateTime(post.sentAt, post.timezone)}.`}
        </StatusBanner>
      )}
      {post.status === "error" && (
        <StatusBanner tone="red" icon={Ban} title="Un incident technique retarde cette publication">
          Votre agence est prévenue et s&apos;en occupe.
        </StatusBanner>
      )}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <PostContent post={post} />
        <div className="grid grid-cols-1 gap-6">
          <Panel title="Échanges avec votre agence">
            <CommentThread postId={post.id} comments={comments} profiles={profiles} timezone={post.timezone} />
          </Panel>
          <Panel title="Historique">
            <ActivityTimeline events={events.filter((event) => CLIENT_EVENT_TYPES.includes(event.type))} profiles={profiles} timezone={post.timezone} />
            <p className="mt-4 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
              Votre validation porte sur ce texte, ce visuel et cette date. Si l&apos;un d&apos;eux change, une nouvelle validation
              vous sera demandée.
            </p>
          </Panel>
          {versions.length > 1 && (
            <Panel title="Versions précédentes">
              <VersionHistory versions={versions} current={post.version} timezone={post.timezone} />
            </Panel>
          )}
        </div>
      </div>

      {/* Mobile : les deux décisions restent accessibles en bas de l'écran. */}
      {decidable && (
        <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:hidden">
          <Button variant="outline" size="lg" className="h-11 flex-1" onClick={() => setDialog("changes")}>
            Modifications
          </Button>
          <Button size="lg" className="h-11 flex-1" onClick={() => setDialog("approve")} disabled={!approvable}>
            <Check /> Approuver
          </Button>
        </div>
      )}

      <Dialog open={dialog === "approve"} onOpenChange={(open) => !open && !pending && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-medium">Approuver cette publication ?</DialogTitle>
            <DialogDescription>
              Elle sera programmée sur {NETWORK_LABELS[post.network]}
              {post.dueAt ? ` pour le ${formatDateTime(post.dueAt, post.timezone)}` : ""}, sans autre intervention.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="lg" onClick={() => setDialog(null)} disabled={pending}>
              Annuler
            </Button>
            <Button size="lg" onClick={approve} disabled={pending}>
              <Check /> {pending ? "Enregistrement…" : "Confirmer l'approbation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "changes"} onOpenChange={(open) => !open && !pending && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-medium">Demander des modifications</DialogTitle>
            <DialogDescription>Expliquez ce que vous souhaitez changer. Votre agence vous renverra une nouvelle version.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="change-body">Votre demande</Label>
            <Textarea
              id="change-body"
              rows={5}
              maxLength={2000}
              value={changeBody}
              onChange={(event) => {
                setChangeBody(event.target.value);
                setChangeError(false);
              }}
              placeholder="Ex. Merci de raccourcir l'accroche et de changer le visuel."
              aria-invalid={changeError}
            />
            {changeError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                Décrivez la modification souhaitée avant d&apos;envoyer.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="lg" onClick={() => setDialog(null)} disabled={pending}>
              Annuler
            </Button>
            <Button size="lg" onClick={sendChanges} disabled={pending}>
              {pending ? "Envoi…" : "Envoyer la demande"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
