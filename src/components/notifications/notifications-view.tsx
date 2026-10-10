"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { BellOff, FlaskConical, Send } from "lucide-react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/shared/page-header";
import { leaveIfExpired } from "@/lib/action-result";
import { formatDateTime } from "@/lib/dates";
import { KIND_META, NOTIFICATION_KINDS, STATUS_LABELS, type NotificationKind, type NotificationPreferences } from "@/lib/domain/notifications";
import type { NotificationEntry } from "@/lib/types";
import { DEFAULT_TIMEZONE } from "@/lib/view";
import { cn } from "@/lib/utils";
import { saveNotificationPreferences } from "@/server/actions";

const STATUS_TONES: Record<NotificationEntry["status"], string> = {
  pending: "bg-tone-amber-soft text-tone-amber",
  sending: "bg-tone-amber-soft text-tone-amber",
  sent: "bg-tone-green-soft text-tone-green",
  simulated: "bg-tone-neutral-soft text-tone-neutral",
  failed: "bg-tone-red-soft text-tone-red",
  cancelled: "bg-tone-neutral-soft text-tone-neutral",
};

export interface NotificationRow extends NotificationEntry {
  title: string;
  href: string | null;
  recipientName: string | null;
}

function Preferences({ audience, initial }: { audience: "admin" | "client"; initial: NotificationPreferences }) {
  const [values, setValues] = useState(initial);
  const [pending, startTransition] = useTransition();

  const toggle = (kind: NotificationKind, enabled: boolean) => {
    const previous = values;
    setValues({ ...values, [kind]: enabled });
    startTransition(async () => {
      const result = await saveNotificationPreferences({ [kind]: enabled });
      if (leaveIfExpired(result)) return;
      if (!result.ok) {
        setValues(previous);
        toast.error(result.message);
      }
    });
  };

  return (
    <ul className="overflow-hidden rounded-2xl border bg-card" data-testid="notification-preferences">
      {NOTIFICATION_KINDS.filter((kind) => KIND_META[kind].audience === audience).map((kind) => (
        <li key={kind} className="border-b last:border-b-0">
          <label className="flex cursor-pointer items-start gap-3 px-5 py-4">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
              checked={values[kind]}
              disabled={pending}
              onChange={(event) => toggle(kind, event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{KIND_META[kind].label}</span>
              <span className="block text-sm text-muted-foreground">{KIND_META[kind].description}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function NotificationsView({
  audience,
  preferences,
  rows,
  delivery,
}: {
  audience: "admin" | "client";
  preferences: NotificationPreferences;
  /** null : la base n'a pas la migration 0007. */
  rows: NotificationRow[] | null;
  /** Mode de remise, affiché à l'administrateur uniquement. */
  delivery?: "simulate" | "webhook";
}) {
  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader
        title="Notifications"
        description={
          audience === "admin"
            ? "Les e-mails envoyés aux clients et à vous-même, et ce dont vous souhaitez être prévenu."
            : "Choisissez d'être prévenu par e-mail quand une publication attend votre validation."
        }
      />

      {rows === null ? (
        <EmptyState icon={BellOff} title="Notifications indisponibles" description={audience === "admin" ? "La base n'a pas encore reçu la migration 0007 (voir docs/NOTIFICATIONS.md)." : "Cette fonction n'est pas encore activée."} />
      ) : (
        <>
          {delivery && (
            <p
              data-testid="notification-mode"
              className={cn("flex items-start gap-3 rounded-2xl px-4 py-3 text-sm", delivery === "simulate" ? "bg-tone-neutral-soft text-tone-neutral" : "bg-tone-green-soft text-tone-green")}
            >
              {delivery === "simulate" ? <FlaskConical className="mt-0.5 size-4 shrink-0" /> : <Send className="mt-0.5 size-4 shrink-0" />}
              <span>
                <span className="font-semibold">{delivery === "simulate" ? "Mode simulation." : "Envoi réel activé."}</span>{" "}
                {delivery === "simulate"
                  ? "Aucun e-mail ne part : chaque notification est enregistrée ci-dessous comme « simulée », pour voir ce qui serait envoyé."
                  : "Chaque message est remis au webhook configuré, qui expédie l'e-mail."}
              </span>
            </p>
          )}

          <section aria-labelledby="preferences-title">
            <h2 id="preferences-title" className="mb-3 font-display text-xl font-medium">
              {audience === "admin" ? "Me prévenir" : "Mes préférences"}
            </h2>
            <Preferences audience={audience} initial={preferences} />
          </section>

          <section aria-labelledby="history-title">
            <h2 id="history-title" className="mb-3 font-display text-xl font-medium">
              Historique
            </h2>
            {rows.length === 0 ? (
              <p className="rounded-2xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Aucune notification pour l&apos;instant.</p>
            ) : (
              <ul className="overflow-hidden rounded-2xl border bg-card" data-testid="notification-history">
                {rows.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b px-4 py-3 text-sm last:border-b-0">
                    <span className="w-36 shrink-0 text-muted-foreground tabular-nums">{formatDateTime(row.createdAt, DEFAULT_TIMEZONE)}</span>
                    <span className="min-w-0 flex-1 basis-64">
                      <span className="font-medium">{KIND_META[row.kind].label}</span>
                      {row.recipientName && <span className="text-muted-foreground"> → {row.recipientName}</span>}
                      {row.href ? (
                        <Link href={row.href} className="block truncate text-brand hover:underline">
                          {row.title}
                        </Link>
                      ) : (
                        <span className="block truncate text-muted-foreground">{row.title}</span>
                      )}
                      {row.error && <span className="block text-xs text-tone-red">{row.error}</span>}
                    </span>
                    <span className={cn("inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium", STATUS_TONES[row.status])}>{STATUS_LABELS[row.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
