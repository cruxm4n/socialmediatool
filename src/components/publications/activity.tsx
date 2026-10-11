import {
  Ban,
  CircleCheckBig,
  CircleDot,
  MessageSquare,
  MessageSquareWarning,
  PenLine,
  Rocket,
  Send,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import { formatDateTime } from "@/lib/dates";
import type { PostEvent, PostEventType, Profile } from "@/lib/types";
import { cn } from "@/lib/utils";

const NEUTRAL = "bg-muted text-muted-foreground";
const AMBER = "bg-tone-amber-soft text-tone-amber";
const GREEN = "bg-tone-green-soft text-tone-green";
const RED = "bg-tone-red-soft text-tone-red";
const BLUE = "bg-tone-blue-soft text-tone-blue";

/** `actor: true` : la phrase commence par le nom de la personne. */
const EVENT_META: Record<PostEventType, { icon: LucideIcon; tone: string; actor?: boolean; text: (event: PostEvent) => string }> = {
  submitted: { icon: Send, tone: AMBER, text: (event) => `Version ${event.version} soumise à validation` },
  updated: { icon: PenLine, tone: NEUTRAL, text: (event) => `Contenu modifié dans Buffer : version ${event.version}` },
  resubmitted: { icon: Send, tone: AMBER, text: (event) => `Nouvelle version ${event.version} soumise après modifications` },
  withdrawn: { icon: Undo2, tone: NEUTRAL, text: () => "Retirée de la validation (tag retiré dans Buffer)" },
  approved: { icon: CircleCheckBig, tone: GREEN, actor: true, text: (event) => `a approuvé la version ${event.version}` },
  changes_requested: { icon: MessageSquareWarning, tone: "bg-tone-rose-soft text-tone-rose", actor: true, text: () => "a demandé des modifications" },
  commented: { icon: MessageSquare, tone: NEUTRAL, actor: true, text: () => "a commenté" },
  approval_invalidated: {
    icon: ShieldAlert,
    tone: AMBER,
    text: (event) => `Validation annulée : le contenu a changé dans Buffer (version ${event.version})`,
  },
  date_set: { icon: CircleDot, tone: BLUE, text: () => "Date fixée dans Buffer après l'accord du client : l'accord reste valable" },
  unscheduled_in_buffer: { icon: ShieldAlert, tone: AMBER, text: () => "Repassée en brouillon dans Buffer : nouvelle validation demandée" },
  scheduled: { icon: CircleDot, tone: BLUE, text: () => "Programmée dans Buffer" },
  schedule_failed: { icon: TriangleAlert, tone: RED, text: () => "Échec de la programmation dans Buffer" },
  unscheduled: { icon: Undo2, tone: AMBER, text: () => "Déprogrammée dans Buffer après modification" },
  published: { icon: Rocket, tone: GREEN, text: () => "Publiée par Buffer" },
  failed: { icon: Ban, tone: RED, text: () => "Erreur signalée par Buffer" },
  removed: { icon: Trash2, tone: NEUTRAL, text: () => "Supprimée dans Buffer" },
};

export function ActivityTimeline({
  events,
  profiles,
  timezone,
  renderContext,
  className,
}: {
  events: PostEvent[];
  profiles: Profile[];
  timezone: string;
  /** Affiche le post concerné dans un historique global. */
  renderContext?: (event: PostEvent) => React.ReactNode;
  className?: string;
}) {
  const sorted = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucun événement pour le moment.</p>;
  }

  return (
    <ol className={cn("relative", className)}>
      {sorted.map((event, index) => {
        const meta = EVENT_META[event.type];
        if (!meta) return null;
        const actor = profiles.find((profile) => profile.id === event.actorId);
        return (
          <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
            {index < sorted.length - 1 && <span className="absolute top-7 bottom-0 left-3.5 w-px bg-border" aria-hidden="true" />}
            <span className={cn("relative flex size-7 shrink-0 items-center justify-center rounded-full", meta.tone)}>
              <meta.icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-sm leading-snug">
                {meta.actor && <span className="font-medium">{actor?.fullName ?? "Un utilisateur"} </span>}
                {meta.text(event)}
              </p>
              {renderContext?.(event)}
              {event.detail && <p className="mt-0.5 text-xs text-muted-foreground">{event.detail}</p>}
              <p className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(event.createdAt, timezone)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
