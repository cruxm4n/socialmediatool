"use client";

import { useState } from "react";
import {
  Bookmark,
  Globe,
  Heart,
  MessageCircle,
  MessageSquare,
  Music2,
  Repeat2,
  Send,
  Share2,
  ThumbsUp,
  VideoOff,
} from "lucide-react";

import { MediaThumb } from "@/components/shared/media-thumb";
import type { PostView } from "@/lib/view";
import { cn } from "@/lib/utils";

interface PreviewProps {
  post: PostView;
}

/** Nom affiché du compte : celui du canal Buffer, à défaut celui du client. */
function accountName(post: PostView): string {
  return post.channel?.displayName || post.channel?.name || post.organization?.name || "Compte";
}

/** Avatar du compte : couleur et initiales du client, comme dans le reste de l'interface. */
function AccountAvatar({ post, className }: { post: PostView; className?: string }) {
  const name = accountName(post);
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: post.organization?.color ?? "#6b7280" }}
      className={cn("inline-flex size-11 shrink-0 items-center justify-center text-sm font-semibold text-white", className)}
    >
      {post.organization?.initials ?? name.replace(/^@/, "").slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Met en couleur les hashtags et mentions, comme le font les réseaux. */
function RichText({ text, linkClass }: { text: string; linkClass: string }) {
  const parts = text.split(/([#@][\p{L}\p{N}_.]+)/gu);
  return (
    <>
      {parts.map((part, index) =>
        /^[#@]/.test(part) ? (
          <span key={index} className={linkClass}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Texte tronqué avec un bouton « voir plus », comme dans les fils d'actualité. */
function ClampedText({
  text,
  limit,
  linkClass,
  className,
  prefix,
}: {
  text: string;
  limit: number;
  linkClass: string;
  className?: string;
  prefix?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsClamp = text.length > limit;
  const shown = !needsClamp || expanded ? text : `${text.slice(0, limit).replace(/\s+\S*$/, "").replace(/[.,;:]$/, "")}…`;
  return (
    <p className={cn("text-[13px] leading-[1.45] whitespace-pre-line", className)}>
      {prefix}
      <RichText text={shown} linkClass={linkClass} />
      {needsClamp && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="ml-1 font-medium text-neutral-500 hover:underline"
        >
          {expanded ? "voir moins" : "voir plus"}
        </button>
      )}
    </p>
  );
}

function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[380px] overflow-hidden rounded-2xl border border-neutral-200 bg-white text-neutral-900 shadow-soft", className)}>
      {children}
    </div>
  );
}

function ActionRow({ items }: { items: { icon: React.ComponentType<{ className?: string }>; label: string }[] }) {
  return (
    <div className="flex items-center justify-around border-t border-neutral-200 px-2 py-2 text-neutral-500" aria-hidden="true">
      {items.map((item) => (
        <span key={item.label} className="flex min-w-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap">
          <item.icon className="size-4 shrink-0" />
          {/* Étroit (mobile, colonne latérale du Studio) : les pictogrammes seuls, plutôt que des mots coupés. */}
          <span className="hidden min-[480px]:inline xl:max-[1500px]:hidden">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function LinkedInPreview({ post }: PreviewProps) {
  const media = post.assets;
  return (
    <Frame>
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <AccountAvatar post={post} className="rounded-md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{accountName(post)}</p>
          {post.organization && <p className="truncate text-xs text-neutral-500">{post.organization.sector}</p>}
          <p className="flex items-center gap-1 text-xs text-neutral-500">
            À l&apos;instant · <Globe className="size-3" />
          </p>
        </div>
      </div>
      <ClampedText text={post.text} limit={210} linkClass="font-medium text-[#0a66c2]" className="px-4 py-3" />
      {media[0] && <MediaThumb asset={media[0]} className="aspect-square w-full" />}
      <ActionRow
        items={[
          { icon: ThumbsUp, label: "J'aime" },
          { icon: MessageSquare, label: "Commenter" },
          { icon: Repeat2, label: "Republier" },
          { icon: Send, label: "Envoyer" },
        ]}
      />
    </Frame>
  );
}

function FacebookPreview({ post }: PreviewProps) {
  const media = post.assets;
  return (
    <Frame>
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <AccountAvatar post={post} className="rounded-full" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{accountName(post)}</p>
          <p className="flex items-center gap-1 text-xs text-neutral-500">
            À l&apos;instant · <Globe className="size-3" />
          </p>
        </div>
      </div>
      <ClampedText text={post.text} limit={280} linkClass="text-[#1877f2]" className="px-4 py-3 text-sm" />
      {media[0] && <MediaThumb asset={media[0]} className="aspect-square w-full" />}
      <ActionRow
        items={[
          { icon: ThumbsUp, label: "J'aime" },
          { icon: MessageSquare, label: "Commenter" },
          { icon: Share2, label: "Partager" },
        ]}
      />
    </Frame>
  );
}

function InstagramPreview({ post }: PreviewProps) {
  const media = post.assets;
  const handle = accountName(post).replace(/^@/, "");
  return (
    <Frame>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="rounded-full bg-linear-to-tr from-[#f9ce34] via-[#ee2a7b] to-[#6228d7] p-[2px]">
          <AccountAvatar post={post} className="size-8 rounded-full text-xs ring-2 ring-white" />
        </span>
        <p className="truncate text-sm font-semibold">{handle}</p>
      </div>
      {media[0] ? (
        <MediaThumb asset={media[0]} className={cn("w-full", media[0].type === "video" ? "aspect-4/5" : "aspect-square")} />
      ) : (
        <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 bg-neutral-100 px-6 text-center text-neutral-500">
          <VideoOff className="size-6" />
          <p className="text-xs font-medium">Instagram exige un visuel</p>
        </div>
      )}
      <div className="flex items-center gap-3.5 px-3 pt-2.5 text-neutral-900" aria-hidden="true">
        <Heart className="size-[22px]" />
        <MessageCircle className="size-[22px]" />
        <Send className="size-[22px]" />
        <Bookmark className="ml-auto size-[22px]" />
      </div>
      <ClampedText
        text={post.text}
        limit={125}
        linkClass="text-[#00376b]"
        className="px-3 pt-2 pb-3.5"
        prefix={<span className="mr-1.5 font-semibold">{handle}</span>}
      />
    </Frame>
  );
}

function TikTokPreview({ post }: PreviewProps) {
  const videoAsset = post.assets.find((asset) => asset.type === "video");
  const handle = accountName(post);
  return (
    <div className="relative mx-auto aspect-9/16 w-full max-w-[270px] overflow-hidden rounded-[1.75rem] border border-neutral-800 bg-neutral-950 text-white shadow-soft">
      {videoAsset ? (
        <MediaThumb asset={videoAsset} className="absolute inset-0" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center text-neutral-400">
          <VideoOff className="size-7" />
          <p className="text-xs font-medium">TikTok exige une vidéo. Aucune vidéo n&apos;est associée à cette déclinaison.</p>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-black/75 to-transparent" />
      <div className="absolute right-2.5 bottom-20 flex flex-col items-center gap-4" aria-hidden="true">
        <AccountAvatar post={post} className="size-8 rounded-full text-xs ring-2 ring-white" />
        <Heart className="size-6 fill-white" />
        <MessageCircle className="size-6 fill-white" />
        <Bookmark className="size-6 fill-white" />
        <Share2 className="size-6" />
      </div>
      <div className="absolute right-14 bottom-4 left-3.5">
        <p className="text-sm font-semibold">{handle}</p>
        <p className="mt-1 line-clamp-3 text-xs leading-snug whitespace-pre-line">
          <RichText text={post.text} linkClass="font-semibold" />
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-white/85">
          <Music2 className="size-3" /> son original — {handle}
        </p>
      </div>
    </div>
  );
}

function XPreview({ post }: PreviewProps) {
  const name = accountName(post);
  const media = post.assets;
  return (
    <Frame>
      <div className="flex gap-3 px-4 pt-3.5 pb-1">
        <AccountAvatar post={post} className="size-10 rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1.5 text-sm">
            <span className="truncate font-bold">{name}</span>
            <span className="truncate text-neutral-500">@{name.replace(/^@/, "").replace(/\s+/g, "")} · maintenant</span>
          </p>
          <p className="mt-0.5 text-[15px] leading-snug whitespace-pre-line">
            <RichText text={post.text} linkClass="text-[#1d9bf0]" />
          </p>
          {media[0] && <MediaThumb asset={media[0]} className="mt-3 aspect-video w-full rounded-2xl border border-neutral-200" />}
          <div className="mt-3 flex items-center justify-between pb-2 text-neutral-500" aria-hidden="true">
            <MessageCircle className="size-4" />
            <Repeat2 className="size-4" />
            <Heart className="size-4" />
            <Bookmark className="size-4" />
            <Share2 className="size-4" />
          </div>
        </div>
      </div>
    </Frame>
  );
}

function GenericPreview({ post }: PreviewProps) {
  return (
    <Frame>
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <AccountAvatar post={post} className="rounded-full" />
        <p className="truncate text-sm font-semibold">{accountName(post)}</p>
      </div>
      <p className="px-4 py-3 text-sm leading-relaxed whitespace-pre-line">{post.text}</p>
      {post.assets[0] && <MediaThumb asset={post.assets[0]} className="aspect-video w-full" />}
    </Frame>
  );
}

/** Simulation visuelle d'un post tel qu'il apparaîtrait sur le réseau. */
export function NetworkPreview({ post }: PreviewProps) {
  const Preview = {
    linkedin: LinkedInPreview,
    instagram: InstagramPreview,
    facebook: FacebookPreview,
    tiktok: TikTokPreview,
    twitter: XPreview,
    other: GenericPreview,
  }[post.network];

  return (
    <figure>
      <Preview post={post} />
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">
        Aperçu simulé — le rendu réel sur le réseau peut différer légèrement.
      </figcaption>
    </figure>
  );
}
