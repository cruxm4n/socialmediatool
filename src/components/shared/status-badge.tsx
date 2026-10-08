import { cn } from "@/lib/utils";
import { STATUS_META, type Tone } from "@/lib/domain/status";
import type { DisplayStatus } from "@/lib/types";

export const TONE_CLASSES: Record<Tone, { badge: string; dot: string; bar: string }> = {
  neutral: { badge: "bg-tone-neutral-soft text-tone-neutral", dot: "bg-tone-neutral/60", bar: "bg-tone-neutral/40" },
  amber: { badge: "bg-tone-amber-soft text-tone-amber", dot: "bg-tone-amber", bar: "bg-tone-amber" },
  rose: { badge: "bg-tone-rose-soft text-tone-rose", dot: "bg-tone-rose", bar: "bg-tone-rose" },
  green: { badge: "bg-tone-green-soft text-tone-green", dot: "bg-tone-green", bar: "bg-tone-green" },
  blue: { badge: "bg-tone-blue-soft text-tone-blue", dot: "bg-tone-blue", bar: "bg-tone-blue" },
  red: { badge: "bg-tone-red-soft text-tone-red", dot: "bg-tone-red", bar: "bg-tone-red" },
};

export function StatusBadge({ status, className }: { status: DisplayStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      title={meta.description}
      data-status={status}
      className={cn(
        "inline-flex h-6 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[meta.tone].badge,
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASSES[meta.tone].dot)} aria-hidden="true" />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

export function statusBar(status: DisplayStatus): string {
  return TONE_CLASSES[STATUS_META[status].tone].bar;
}
