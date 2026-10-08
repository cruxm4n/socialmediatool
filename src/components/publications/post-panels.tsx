import { CircleAlert, ExternalLink, TriangleAlert } from "lucide-react";

import { NetworkPreview } from "@/components/publications/network-preview";
import { MediaThumb } from "@/components/shared/media-thumb";
import { NetworkIcon } from "@/components/shared/network-icon";
import { formatDateTime } from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import { safeExternalUrl, type PostAlert } from "@/lib/domain/status";
import type { PostView } from "@/lib/view";
import { cn } from "@/lib/utils";

export function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border bg-card p-4 sm:p-5", className)}>
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

const BANNER_TONES = {
  neutral: "border-border bg-card text-muted-foreground [&_[data-title]]:text-foreground [&_[data-icon]]:bg-muted [&_[data-icon]]:text-muted-foreground",
  amber: "border-tone-amber/20 bg-tone-amber-soft/60 text-tone-amber [&_[data-icon]]:bg-tone-amber-soft",
  rose: "border-tone-rose/20 bg-tone-rose-soft/60 text-tone-rose [&_[data-icon]]:bg-tone-rose-soft",
  green: "border-tone-green/20 bg-tone-green-soft/60 text-tone-green [&_[data-icon]]:bg-tone-green-soft",
  blue: "border-tone-blue/20 bg-tone-blue-soft/60 text-tone-blue [&_[data-icon]]:bg-tone-blue-soft",
  red: "border-tone-red/20 bg-tone-red-soft/60 text-tone-red [&_[data-icon]]:bg-tone-red-soft",
};

export function StatusBanner({
  tone,
  icon: Icon,
  title,
  children,
  action,
}: {
  tone: keyof typeof BANNER_TONES;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-wrap items-start gap-3 rounded-2xl border p-4", BANNER_TONES[tone])} data-testid="status-banner">
      <span data-icon className="flex size-8 shrink-0 items-center justify-center rounded-full">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-64 text-sm leading-relaxed">
        <p data-title className="font-semibold">
          {title}
        </p>
        <div className="text-foreground/75">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function AlertList({ alerts }: { alerts: PostAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <ul className="grid gap-2">
      {alerts.map((alert) => (
        <li
          key={alert.message}
          role="alert"
          className={cn(
            "flex gap-2.5 rounded-xl px-3.5 py-2.5 text-sm",
            alert.level === "error" ? "bg-tone-red-soft text-tone-red" : "bg-tone-amber-soft text-tone-amber",
          )}
        >
          {alert.level === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
          {alert.message}
        </li>
      ))}
    </ul>
  );
}

/** Contenu du post à gauche, aperçu simulé du réseau à droite. */
export function PostContent({ post, showTechnical = false }: { post: PostView; showTechnical?: boolean }) {
  const externalLink = safeExternalUrl(post.externalLink);
  return (
    <section className="overflow-hidden rounded-2xl border bg-card">
      <div className="grid grid-cols-1 gap-6 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <dl className="grid content-start gap-5">
          <Field label="Réseau">
            <span className="flex items-center gap-2 font-medium">
              <NetworkIcon network={post.network} />
              {NETWORK_LABELS[post.network]}
              {post.channel && <span className="font-normal text-muted-foreground">· {post.channel.displayName || post.channel.name}</span>}
            </span>
          </Field>

          <Field label="Date prévue">
            <span className="font-medium" data-testid="post-date">
              {post.dueAt ? formatDateTime(post.dueAt, post.timezone) : "Sans date"}
            </span>{" "}
            <span className="text-xs text-muted-foreground">heure de Paris</span>
          </Field>

          <Field label="Texte">
            <p className="rounded-xl bg-muted/60 px-3.5 py-3 leading-relaxed whitespace-pre-line" data-testid="post-text">
              {post.text || "Post sans texte"}
            </p>
            {showTechnical && <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">{post.text.length} caractères</p>}
          </Field>

          <Field label="Médias">
            {post.assets.length === 0 ? (
              <span className="text-muted-foreground">Aucun média.</span>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {post.assets.map((asset, index) => (
                  <li key={`${asset.source}-${index}`}>
                    <MediaThumb asset={asset} className="size-20 rounded-xl border" alt={`Média ${index + 1}`} />
                  </li>
                ))}
              </ul>
            )}
          </Field>

          {externalLink && (
            <Field label="Publication en ligne">
              <a href={externalLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline">
                Voir sur {NETWORK_LABELS[post.network]} <ExternalLink className="size-3.5" />
              </a>
            </Field>
          )}

          {showTechnical && (
            <Field label="Référence Buffer">
              <code className="font-mono text-xs break-all text-muted-foreground">{post.bufferPostId}</code>
            </Field>
          )}
        </dl>

        <div className="rounded-2xl bg-muted/50 p-4 sm:p-6">
          <NetworkPreview post={post} />
        </div>
      </div>
    </section>
  );
}
