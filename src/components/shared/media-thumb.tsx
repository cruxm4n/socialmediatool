import { ImageOff, Play } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PostAsset } from "@/lib/types";

/** Vignette d'un média Buffer. Sans média, affiche un emplacement vide explicite. */
export function MediaThumb({ asset, className, alt = "" }: { asset: PostAsset | undefined; className?: string; alt?: string }) {
  if (!asset) {
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground/60", className)} aria-label="Aucun visuel">
        <ImageOff className="size-1/3 max-h-5 max-w-5" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {/* Les médias sont hébergés par Buffer, sur des domaines non connus à l'avance : balise img simple. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={asset.thumbnail || asset.source} alt={alt} loading="lazy" className="absolute inset-0 size-full object-cover" />
      {asset.type === "video" && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-1/3 max-h-10 min-h-4 max-w-10 min-w-4 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play className="size-1/2 fill-current" aria-hidden="true" />
          </span>
        </span>
      )}
    </div>
  );
}
