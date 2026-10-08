import { cn } from "@/lib/utils";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import type { Network } from "@/lib/types";

/*
 * Pictogrammes simplifiés dessinés pour le projet : ils évoquent chaque réseau
 * sans reprendre les logos officiels.
 */
const GLYPHS: Record<Network, React.ReactNode> = {
  linkedin: (
    <path
      fill="currentColor"
      d="M6.4 9.6h2.7V18H6.4zM7.75 5.5a1.55 1.55 0 1 1 0 3.1 1.55 1.55 0 0 1 0-3.1M11 9.6h2.6v1.15c.5-.8 1.4-1.4 2.7-1.4 2.2 0 3.1 1.4 3.1 3.7V18h-2.7v-4.5c0-1.1-.4-1.8-1.35-1.8-1.05 0-1.65.7-1.65 1.9V18H11z"
    />
  ),
  instagram: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="5" width="14" height="14" rx="4.2" />
      <circle cx="12" cy="12" r="3.3" />
      <circle cx="16.2" cy="7.8" r="0.6" fill="currentColor" />
    </g>
  ),
  facebook: (
    <path
      fill="currentColor"
      d="M13.4 20v-6.6h2.2l.4-2.7h-2.6V9.1c0-.8.3-1.3 1.4-1.3h1.3V5.4c-.4-.1-1.1-.2-2-.2-2.1 0-3.4 1.25-3.4 3.5v2H8.5v2.7h2.2V20z"
    />
  ),
  twitter: (
    <path
      fill="currentColor"
      d="M6 5.5h3.1l3.4 4.6 4-4.6h1.9l-5 5.8 5.4 7.2h-3.1l-3.7-5-4.3 5H5.8l5.4-6.2zm2.4 1.2 7.9 10.6h.9L9.3 6.7z"
    />
  ),
  other: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="6.5" />
      <path d="M5.5 12h13M12 5.5c2 2 2 11 0 13M12 5.5c-2 2-2 11 0 13" />
    </g>
  ),
  tiktok: (
    <path
      fill="currentColor"
      d="M13.6 4.6h2.4c.2 1.7 1.2 2.9 3 3.1v2.4c-1.1 0-2.1-.3-3-.9v5.5a4.6 4.6 0 1 1-4.6-4.6c.3 0 .5 0 .8.1v2.5a2.15 2.15 0 1 0 1.4 2z"
    />
  ),
};

const TILE_COLORS: Record<Network, string> = {
  linkedin: "bg-net-linkedin",
  instagram: "bg-net-instagram",
  facebook: "bg-net-facebook",
  tiktok: "bg-net-tiktok",
  twitter: "bg-net-tiktok",
  other: "bg-tone-neutral",
};

const SIZES = {
  xs: "size-4 rounded-[5px]",
  sm: "size-5 rounded-md",
  md: "size-7 rounded-lg",
  lg: "size-9 rounded-xl",
};

export function NetworkIcon({
  network,
  size = "sm",
  className,
}: {
  network: Network;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={NETWORK_LABELS[network]}
      title={NETWORK_LABELS[network]}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-white",
        TILE_COLORS[network],
        SIZES[size],
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
        {GLYPHS[network]}
      </svg>
    </span>
  );
}

/** Pile compacte d'icônes pour résumer les réseaux d'un contenu. */
export function NetworkStack({ networks, size = "sm" }: { networks: Network[]; size?: keyof typeof SIZES }) {
  return (
    <span className="inline-flex items-center -space-x-1">
      {networks.map((network) => (
        <NetworkIcon key={network} network={network} size={size} className="ring-2 ring-card" />
      ))}
    </span>
  );
}
