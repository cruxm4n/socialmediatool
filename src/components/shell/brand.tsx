import Link from "next/link";

import { cn } from "@/lib/utils";

export function Brand({ href, className }: { href: string; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)}>
      <span className="flex size-8 items-center justify-center rounded-[10px] bg-primary text-primary-foreground">
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path d="M5 16V8M10 18V6M15 15V9M20 13v-2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
        </svg>
      </span>
      <span className="flex flex-col leading-none">
        <span className="font-display text-xl font-medium leading-none">Cadence</span>
        <span className="mt-1 text-[11px] leading-none text-muted-foreground">by LouisR</span>
      </span>
    </Link>
  );
}
