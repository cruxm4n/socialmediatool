import Link from "next/link";
import { CalendarDays } from "lucide-react";

import { MediaThumb } from "@/components/shared/media-thumb";
import { NetworkIcon } from "@/components/shared/network-icon";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDateTime } from "@/lib/dates";
import type { PostView } from "@/lib/view";
import { cn } from "@/lib/utils";

/** Carte visuelle d'un post : visuel, statut, réseau et date prévue. */
export function PostCard({ post, href, showOrg = false, className }: { post: PostView; href: string; showOrg?: boolean; className?: string }) {
  return (
    <Link
      href={href}
      data-post={post.bufferPostId}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border bg-card outline-none transition-all hover:-translate-y-0.5 hover:shadow-lift focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <div className="relative">
        <MediaThumb asset={post.assets[0]} className="aspect-16/10 w-full" />
        <StatusBadge status={post.status} className="absolute top-3 left-3 shadow-soft ring-1 ring-black/5" />
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        {showOrg && post.organization && (
          <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <OrgAvatar organization={post.organization} size="sm" className="size-5 text-[9px]" />
            {post.organization.name}
          </p>
        )}
        <p className="line-clamp-3 text-sm leading-relaxed">{post.text || "Post sans texte"}</p>
        <div className="mt-auto flex items-center justify-between gap-3 pt-1">
          <NetworkIcon network={post.network} />
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <CalendarDays className="size-3.5" />
            {post.dueAt ? formatDateTime(post.dueAt, post.timezone) : "Sans date"}
          </span>
        </div>
      </div>
    </Link>
  );
}
