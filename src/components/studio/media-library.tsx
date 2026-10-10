"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, Film, ImagePlus, Images, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/page-header";
import { useAdmin } from "@/components/shell/admin-context";
import { Button } from "@/components/ui/button";
import { leaveIfExpired } from "@/lib/action-result";
import { ACCEPTED_MIME_TYPES, validateFile } from "@/lib/domain/studio";
import { getBrowserClient } from "@/lib/supabase-browser";
import type { MediaAsset } from "@/lib/types";
import { cn } from "@/lib/utils";
import { registerMedia, setMediaArchived } from "@/server/studio-actions";

/** Dimensions d'une image ou d'une vidéo, lues dans le navigateur avant le dépôt. */
interface MediaDetails {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

async function probe(file: File): Promise<MediaDetails> {
  const empty: MediaDetails = { width: null, height: null, durationMs: null };
  try {
    if (file.type.startsWith("image/")) {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height, durationMs: null };
      bitmap.close();
      return size;
    }
    return await new Promise<MediaDetails>((resolve) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      const done = (value: MediaDetails) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      video.preload = "metadata";
      video.onloadedmetadata = () => done({ width: video.videoWidth || null, height: video.videoHeight || null, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null });
      video.onerror = () => done(empty);
      video.src = url;
    });
  } catch {
    return empty;
  }
}

/** Dépose un fichier dans le dossier du client, puis l'inscrit à la bibliothèque. Renvoie son identifiant. */
async function upload(config: { url: string; key: string }, organizationId: string, file: File): Promise<string | null> {
  const problem = validateFile(file);
  if (problem) {
    toast.error(problem.message);
    return null;
  }
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
  const path = `${organizationId}/${crypto.randomUUID()}.${extension}`;
  const [details, stored] = await Promise.all([probe(file), getBrowserClient(config).storage.from("media").upload(path, file, { contentType: file.type, upsert: false })]);
  if (stored.error) {
    toast.error(`« ${file.name} » n'a pas pu être déposé`, { description: stored.error.message });
    return null;
  }
  const result = await registerMedia({ organizationId, path, fileName: file.name, mimeType: file.type, sizeBytes: file.size, ...details });
  if (leaveIfExpired(result)) return null;
  if (!result.ok) {
    toast.error(`« ${file.name} »`, { description: result.message });
    return null;
  }
  return result.id ?? null;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;

export function MediaTile({ asset, className }: { asset: MediaAsset; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {!asset.url ? (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Indisponible</span>
      ) : asset.kind === "video" ? (
        <video src={asset.url} preload="metadata" muted playsInline aria-label={asset.fileName} className="absolute inset-0 size-full object-cover" />
      ) : (
        // Adresse signée et temporaire : balise img simple.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.url} alt={asset.fileName} loading="lazy" className="absolute inset-0 size-full object-cover" />
      )}
      {asset.kind === "video" && (
        <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
          <Film className="size-3" aria-hidden="true" />
          {asset.durationMs ? `${Math.round(asset.durationMs / 1000)} s` : "Vidéo"}
        </span>
      )}
    </div>
  );
}

/**
 * Bibliothèque de médias d'un client. Deux usages :
 * - gestion (page Médias) : déposer, retirer ;
 * - sélection (éditeur) : avec `selectedIds` et `onToggle`, un clic ajoute ou retire le média du contenu.
 */
export function MediaLibrary({
  organizationId,
  media,
  selectedIds,
  onToggle,
}: {
  organizationId: string;
  media: MediaAsset[];
  selectedIds?: string[];
  onToggle?: (asset: MediaAsset) => void;
}) {
  const router = useRouter();
  const { supabase } = useAdmin();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const picking = !!onToggle;
  const visible = media.filter((asset) => asset.archivedAt === null || selectedIds?.includes(asset.id));

  const add = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(files.length);
    let added = 0;
    for (const file of files) {
      if (await upload(supabase, organizationId, file)) added += 1;
      setUploading((count) => count - 1);
    }
    setUploading(0);
    if (added > 0) {
      toast.success(`${added} média${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""} à la bibliothèque`);
      router.refresh();
    }
  };

  const archive = async (asset: MediaAsset) => {
    const result = await setMediaArchived({ id: asset.id, archived: true });
    if (leaveIfExpired(result)) return;
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
    router.refresh();
  };

  return (
    <div
      className={cn("grid grid-cols-1 gap-4 rounded-2xl", dragging && "outline-2 outline-offset-4 outline-brand outline-dashed")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void add([...event.dataTransfer.files]);
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPTED_MIME_TYPES.join(",")}
          className="sr-only"
          aria-label="Choisir des fichiers à déposer"
          onChange={(event) => {
            void add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <Button size="lg" variant={picking ? "outline" : "default"} disabled={uploading > 0} onClick={() => input.current?.click()}>
          {uploading > 0 ? <LoaderCircle className="animate-spin" /> : <ImagePlus />}
          {uploading > 0 ? `Dépôt en cours (${uploading})…` : "Déposer des images ou des vidéos"}
        </Button>
        <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">JPEG, PNG, WebP, GIF, MP4 ou MOV, 50 Mo au plus par fichier. Vous pouvez aussi glisser les fichiers ici.</p>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Images} title="Bibliothèque vide" description="Les images et vidéos déposées pour ce client apparaîtront ici, prêtes à être réutilisées." />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="media-grid">
          {visible.map((asset) => {
            const position = selectedIds?.indexOf(asset.id) ?? -1;
            const tile = (
              <>
                <MediaTile asset={asset} className="aspect-square w-full" />
                {position >= 0 && (
                  <span className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-foreground">
                    {selectedIds!.length > 1 ? position + 1 : <Check className="size-3.5" />}
                  </span>
                )}
              </>
            );
            return (
              <li key={asset.id} className="min-w-0">
                {picking ? (
                  <button
                    type="button"
                    aria-pressed={position >= 0}
                    aria-label={`${position >= 0 ? "Retirer" : "Ajouter"} ${asset.fileName}`}
                    onClick={() => onToggle(asset)}
                    className={cn("relative block w-full overflow-hidden rounded-xl border outline-none focus-visible:ring-3 focus-visible:ring-ring/50", position >= 0 && "ring-2 ring-brand")}
                  >
                    {tile}
                  </button>
                ) : (
                  <div className="relative overflow-hidden rounded-xl border">{tile}</div>
                )}
                <p className="mt-1.5 truncate text-xs font-medium" title={asset.fileName}>
                  {asset.fileName}
                </p>
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">
                    {megabytes(asset.sizeBytes)}
                    {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ""}
                  </span>
                  {!picking && (
                    <button
                      type="button"
                      onClick={() => void archive(asset)}
                      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md font-medium outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <Archive className="size-3" /> Retirer
                    </button>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
