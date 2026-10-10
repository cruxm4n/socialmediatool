"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleCheck, CloudOff, Copy, Images, LoaderCircle, Send, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { NetworkPreview } from "@/components/publications/network-preview";
import { NetworkIcon } from "@/components/shared/network-icon";
import { OrgAvatar } from "@/components/shared/org-avatar";
import { MediaLibrary, MediaTile } from "@/components/studio/media-library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { leaveIfExpired } from "@/lib/action-result";
import { dayKeyOf, formatDateTime, timeOf, zonedToUtcIso, type DayKey } from "@/lib/dates";
import { NETWORK_LABELS } from "@/lib/domain/networks";
import {
  composeText, findConflicts, hasBlockingIssue, NETWORK_RULES, parseHashtags, dedupeHashtags, textLength, validateDraft,
  type ScheduledItem, type StudioMedia,
} from "@/lib/domain/studio";
import { toNetwork, type Channel, type MediaAsset, type Organization, type StudioDraft } from "@/lib/types";
import { studioPostViews } from "@/lib/view";
import { cn } from "@/lib/utils";
import { confirmStudioDraftAbsent, reconcileStudioDraft, saveStudioDraft, submitStudioDraft } from "@/server/studio-actions";

interface Doc {
  title: string;
  day: string;
  time: string;
  hashtags: string[];
  mediaIds: string[];
  /** Canaux choisis, dans l'ordre d'affichage. */
  channelIds: string[];
  texts: Record<string, string>;
}

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
const AUTOSAVE_DELAY_MS = 1200;

function toDoc(draft: StudioDraft | null, timezone: string): Doc {
  return {
    title: draft?.title ?? "",
    day: draft?.dueAt ? dayKeyOf(draft.dueAt, timezone) : "",
    time: draft?.dueAt ? timeOf(draft.dueAt, timezone) : "09:00",
    hashtags: draft?.hashtags ?? [],
    mediaIds: draft?.mediaIds ?? [],
    channelIds: draft?.variants.map((variant) => variant.channelId) ?? [],
    texts: Object.fromEntries(draft?.variants.map((variant) => [variant.channelId, variant.text]) ?? []),
  };
}

const dueAtOf = (doc: Doc, timezone: string) => (doc.day && /^\d{2}:\d{2}$/.test(doc.time) ? zonedToUtcIso(doc.day as DayKey, doc.time, timezone) : null);

const SAVE_LABELS: Record<SaveStatus, string> = {
  idle: "Rien à enregistrer",
  dirty: "Modifications en attente…",
  saving: "Enregistrement…",
  saved: "Enregistré",
  error: "Non enregistré",
};

/**
 * Éditeur d'un contenu : client fixé, canaux, un texte par canal, hashtags communs, date, médias.
 * Chaque modification est enregistrée automatiquement. « Envoyer en validation » crée un brouillon
 * tagué par canal dans Buffer ; rien n'est programmé avant l'accord du client.
 */
export function StudioEditor({
  draft,
  organization,
  channels,
  media,
  scheduled,
  now,
}: {
  /** null : nouveau contenu, créé au premier enregistrement. */
  draft: StudioDraft | null;
  organization: Organization;
  /** Canaux du client. */
  channels: Channel[];
  /** Bibliothèque du client (et médias déjà utilisés par ce contenu). */
  media: MediaAsset[];
  /** Publications déjà prévues, pour signaler les conflits de date. */
  scheduled: ScheduledItem[];
  now: string;
}) {
  const router = useRouter();
  const timezone = organization.timezone;
  const [doc, setDoc] = useState<Doc>(() => toDoc(draft, timezone));
  const [status, setStatus] = useState<SaveStatus>(draft ? "saved" : "idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(draft?.id ?? null);
  const [revision, setRevision] = useState(draft?.revision ?? null);
  const [activeChannel, setActiveChannel] = useState<string | null>(draft?.variants[0]?.channelId ?? null);
  const [hashtagInput, setHashtagInput] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [confirm, setConfirm] = useState<"submit" | "absent" | null>(null);
  const [evidence, setEvidence] = useState("");
  const [submitting, startSubmit] = useTransition();

  // État de la sauvegarde, hors rendu : une seule requête à la fois, la dernière saisie gagne.
  const live = useRef({ doc, id: draft?.id ?? null, revision: draft?.revision ?? null, saving: false, dirty: false, blocked: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushLater = useRef<() => void>(() => undefined);
  const flushOnExit = useRef<() => Promise<boolean>>(async () => true);

  const flush = useCallback(async (): Promise<boolean> => {
    const state = live.current;
    if (timer.current) clearTimeout(timer.current);
    if (state.saving) return false;
    if (!state.dirty || state.blocked) return !state.blocked;
    state.saving = true;
    state.dirty = false;
    setStatus("saving");
    const current = state.doc;
    let result: Awaited<ReturnType<typeof saveStudioDraft>>;
    try {
      result = await saveStudioDraft({
        id: state.id ?? undefined,
        expectedRevision: state.revision ?? undefined,
        organizationId: organization.id,
        title: current.title,
        dueAt: dueAtOf(current, timezone),
        hashtags: current.hashtags,
        mediaIds: current.mediaIds,
        variants: current.channelIds.map((channelId) => ({ channelId, text: current.texts[channelId] ?? "" })),
      });
    } catch {
      result = { ok: false, message: "La connexion a été interrompue. Vos modifications restent à l'écran : elles seront renvoyées à la prochaine saisie." };
    }
    state.saving = false;
    if (leaveIfExpired(result)) return false;
    if (!result.ok) {
      // Conflit de version : on n'insiste pas, pour ne pas écraser ce qui a été fait ailleurs.
      state.blocked = result.code === "stale_revision" || result.code === "draft_archived";
      state.dirty = !state.blocked;
      setStatus("error");
      setSaveError(result.message);
      return false;
    }
    setSaveError(null);
    state.revision = result.revision ?? state.revision;
    setRevision(state.revision);
    if (!state.id && result.id) {
      // L'adresse de la page ne change PAS : un changement de route démonterait l'éditeur et ferait
      // perdre ce qui a été saisi pendant la création (bug observé). Le contenu créé se retrouve dans le Studio.
      state.id = result.id;
      setDraftId(result.id);
    }
    if (state.dirty) {
      // Une saisie est arrivée pendant l'enregistrement : elle part à son tour.
      flushLater.current();
      setStatus("dirty");
    } else {
      setStatus("saved");
    }
    return true;
  }, [organization.id, timezone]);

  useEffect(() => {
    flushOnExit.current = flush;
    flushLater.current = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    };
  }, [flush]);

  const update = (patch: Partial<Doc>) => {
    const next = { ...live.current.doc, ...patch };
    live.current.doc = next;
    live.current.dirty = true;
    setDoc(next);
    if (!live.current.blocked) setStatus("dirty");
    flushLater.current();
  };

  // Fermer l'onglet avec une saisie non enregistrée : le navigateur demande confirmation.
  useEffect(() => {
    const state = live.current;
    const warn = (event: BeforeUnloadEvent) => {
      if (state.dirty || state.saving) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (timer.current) clearTimeout(timer.current);
      // Dernier recours si l'éditeur est quitté avec une saisie en attente : on tente de l'enregistrer.
      if (state.dirty && !state.saving && !state.blocked) void flushOnExit.current();
    };
  }, []);

  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);
  const selectedMedia = doc.mediaIds.map((id) => mediaById.get(id)).filter((item): item is MediaAsset => !!item);
  const selectedChannels = doc.channelIds.map((id) => channels.find((channel) => channel.id === id)).filter((channel): channel is Channel => !!channel);
  const current = selectedChannels.find((channel) => channel.id === activeChannel) ?? selectedChannels[0] ?? null;
  const dueAt = dueAtOf(doc, timezone);
  const variantOf = (channelId: string) => draft?.variants.find((variant) => variant.channelId === channelId);

  const issues = validateDraft(
    { dueAt, hashtags: doc.hashtags, media: selectedMedia as StudioMedia[], variants: doc.channelIds.map((channelId) => ({ channelId, text: doc.texts[channelId] ?? "" })) },
    channels.map((channel) => ({ id: channel.id, network: toNetwork(channel.service), name: channel.displayName ?? channel.name, isDisconnected: channel.isDisconnected })),
    now,
  );
  const blocking = hasBlockingIssue(issues);
  const ownPostIds = draft?.variants.map((variant) => variant.bufferPostId).filter((id): id is string => !!id) ?? [];
  const conflicts = findConflicts(dueAt, doc.channelIds, scheduled.filter((item) => !ownPostIds.includes(item.id)));

  const inBuffer = draft?.variants.filter((variant) => variant.bufferPostId).length ?? 0;
  const failedPush = draft?.variants.filter((variant) => variant.pushState === "failed") ?? [];
  // Création sans réponse de Buffer : le brouillon existe peut-être. Aucun renvoi avant vérification.
  // Résultat inconnu, ou envoi resté « en cours » alors que la page vient d'être chargée : interrompu, donc incertain.
  const unknownPush = draft?.variants.filter((variant) => variant.pushState === "unknown" || (variant.pushState === "pushing" && !submitting)) ?? [];
  const [absenceUnproven, setAbsenceUnproven] = useState(false);
  // Révision affichée différente de celle envoyée : le contenu de Buffer n'est plus celui de l'écran.
  const outdated = inBuffer > 0 && (status !== "saved" || draft!.variants.some((variant) => variant.bufferPostId && variant.pushedRevision !== revision));

  const toggleChannel = (channel: Channel) => {
    if (doc.channelIds.includes(channel.id)) {
      update({ channelIds: doc.channelIds.filter((id) => id !== channel.id) });
      if (activeChannel === channel.id) setActiveChannel(null);
      return;
    }
    // Un nouveau canal reprend le texte du canal affiché : on adapte ensuite, plutôt que de repartir de zéro.
    const seed = doc.texts[channel.id] ?? (current ? (doc.texts[current.id] ?? "") : "");
    update({ channelIds: [...doc.channelIds, channel.id], texts: { ...doc.texts, [channel.id]: seed } });
    setActiveChannel(channel.id);
  };

  const addHashtags = (input: string) => {
    const added = parseHashtags(input);
    if (added.length > 0) update({ hashtags: dedupeHashtags([...doc.hashtags, ...added]) });
    setHashtagInput("");
  };

  const moveMedia = (index: number, direction: -1 | 1) => {
    const next = [...doc.mediaIds];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    update({ mediaIds: next });
  };

  const submit = () =>
    startSubmit(async () => {
      setConfirm(null);
      if (!(await flush()) || !live.current.id) {
        toast.error("Le contenu n'a pas pu être enregistré", { description: "Corrigez le problème signalé avant de l'envoyer." });
        return;
      }
      try {
        // Jamais de renvoi forcé : un résultat inconnu ou un envoi interrompu se résout (vérification) avant tout renvoi.
        const result = await submitStudioDraft({ id: live.current.id });
        if (leaveIfExpired(result)) return;
        if (result.ok) toast.success("Envoyé en validation", { description: result.message });
        else if (result.code === "push_unknown" || result.code === "push_uncertain" || result.code === "submission_unconfirmed") toast.warning("État à vérifier", { description: result.message, duration: 12000 });
        else toast.error("Envoi incomplet", { description: result.message });
        router.refresh();
      } catch {
        toast.error("La confirmation n'a pas été reçue", { description: "Rechargez la page pour voir ce qui a été créé dans Buffer avant de réessayer." });
      }
    });

  const reconcile = () =>
    startSubmit(async () => {
      try {
        const result = await reconcileStudioDraft({ id: live.current.id! });
        if (leaveIfExpired(result)) return;
        if (result.ok) toast.success("Vérification terminée", { description: result.message });
        else toast.warning("Vérification incomplète", { description: result.message, duration: 12000 });
        if (result.code === "push_absent_unproven") setAbsenceUnproven(true);
        router.refresh();
      } catch {
        toast.error("La vérification n'a pas abouti", { description: "Réessayez dans un instant." });
      }
    });

  const confirmAbsent = () =>
    startSubmit(async () => {
      setConfirm(null);
      try {
        const result = await confirmStudioDraftAbsent({ id: live.current.id!, evidence });
        if (leaveIfExpired(result)) return;
        if (result.ok) {
          setAbsenceUnproven(false);
          setEvidence("");
          toast.success("Absence confirmée", { description: result.message });
        } else toast.warning("Confirmation refusée", { description: result.message, duration: 12000 });
        router.refresh();
      } catch {
        toast.error("La confirmation n'a pas abouti", { description: "Réessayez dans un instant." });
      }
    });

  const preview = current
    ? studioPostViews(
        [{
          id: "apercu", organizationId: organization.id, title: "", dueAt, hashtags: doc.hashtags, mediaIds: doc.mediaIds, status: "draft", revision: 0,
          createdAt: now, updatedAt: now, submittedAt: null,
          variants: [{ id: "apercu", channelId: current.id, text: doc.texts[current.id] ?? "", bufferPostId: null, pushState: "idle", pushError: null, pushedRevision: null }],
        }],
        channels, [organization], media,
      )[0]
    : null;
  const currentRules = current ? NETWORK_RULES[toNetwork(current.service)] : null;
  const currentLength = current ? textLength(composeText(doc.texts[current.id] ?? "", doc.hashtags)) : 0;

  return (
    <div className="grid animate-rise grid-cols-1 gap-6" data-testid="studio-editor">
      <div>
        <Link href="/admin/studio" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
          <ArrowLeft className="size-4" /> Studio
        </Link>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-72">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <OrgAvatar organization={organization} size="sm" />
              {organization.name}
            </p>
            <Label htmlFor="studio-title" className="sr-only">
              Titre interne
            </Label>
            <input
              id="studio-title"
              value={doc.title}
              maxLength={120}
              onChange={(event) => update({ title: event.target.value })}
              placeholder="Titre interne (jamais publié)"
              className="mt-2 w-full bg-transparent font-display text-[1.6rem] leading-tight font-medium outline-none placeholder:text-muted-foreground/60 sm:text-[1.9rem]"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <span
              data-testid="save-status"
              data-status={status}
              aria-live="polite"
              className={cn("flex items-center gap-1.5 text-xs font-medium", status === "error" ? "text-tone-red" : "text-muted-foreground")}
            >
              {status === "saving" ? <LoaderCircle className="size-3.5 animate-spin" /> : status === "error" ? <CloudOff className="size-3.5" /> : status === "saved" ? <Check className="size-3.5" /> : null}
              {SAVE_LABELS[status]}
            </span>
            <Button size="lg" disabled={blocking || submitting || status === "error" || unknownPush.length > 0} onClick={() => setConfirm("submit")}>
              {submitting ? <LoaderCircle className="animate-spin" /> : <Send />}
              {inBuffer > 0 ? "Renvoyer en validation" : "Envoyer en validation"}
            </Button>
          </div>
        </div>
      </div>

      {saveError && (
        <p className="flex items-start gap-2 rounded-2xl bg-tone-red-soft px-4 py-3 text-sm text-tone-red" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" /> {saveError}
        </p>
      )}
      {inBuffer > 0 && (
        <p className={cn("flex items-start gap-2 rounded-2xl px-4 py-3 text-sm", outdated ? "bg-tone-amber-soft text-tone-amber" : "bg-tone-green-soft text-tone-green")} data-testid="buffer-state">
          {outdated ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : <CircleCheck className="mt-0.5 size-4 shrink-0" />}
          <span>
            {outdated
              ? "Ce contenu a changé depuis son envoi : le client voit encore l'ancienne version. Renvoyez-le en validation pour mettre Buffer à jour — toute approbation déjà donnée sera alors à redemander."
              : `Envoyé en validation : ${inBuffer} brouillon${inBuffer > 1 ? "s" : ""} dans Buffer. Le client peut répondre depuis son espace.`}
          </span>
        </p>
      )}
      {unknownPush.length > 0 && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-tone-amber-soft px-4 py-3 text-sm text-tone-amber" role="alert" data-testid="push-unknown">
          <p className="flex min-w-0 flex-1 basis-72 items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              L&apos;envoi de {unknownPush.length > 1 ? `${unknownPush.length} brouillons` : "un brouillon"} a été interrompu ou Buffer n&apos;a pas répondu : il existe peut-être déjà.
              Le renvoi est bloqué, y compris forcé, tant que le brouillon n&apos;a pas été retrouvé ou son absence confirmée, pour ne pas créer de doublon.
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={submitting} onClick={reconcile}>
              Vérifier dans Buffer
            </Button>
            {absenceUnproven && (
              <Button variant="outline" size="sm" disabled={submitting} onClick={() => setConfirm("absent")} data-testid="confirm-absent">
                J&apos;ai vérifié : aucun brouillon
              </Button>
            )}
          </div>
        </div>
      )}
      {failedPush.map((variant) => {
        const channel = channels.find((item) => item.id === variant.channelId);
        return (
          <p key={variant.id} className="flex items-start gap-2 rounded-2xl bg-tone-red-soft px-4 py-3 text-sm text-tone-red">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="font-semibold">{channel ? `${NETWORK_LABELS[toNetwork(channel.service)]} · ${channel.displayName ?? channel.name}` : "Canal"} :</span> l&apos;envoi vers Buffer a échoué. {variant.pushError}
            </span>
          </p>
        );
      })}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="grid grid-cols-1 gap-6">
          <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="channels-title">
            <h2 id="channels-title" className="text-sm font-semibold">
              Canaux
            </h2>
            {channels.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Aucun canal Buffer n&apos;est rattaché à ce client.{" "}
                <Link href={`/admin/clients/${organization.id}`} className="font-medium text-brand hover:underline">
                  Rattacher un canal
                </Link>
              </p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {channels.map((channel) => {
                  const checked = doc.channelIds.includes(channel.id);
                  const locked = !!variantOf(channel.id)?.bufferPostId;
                  return (
                    <li key={channel.id}>
                      <label
                        className={cn(
                          "flex h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                          checked ? "border-brand bg-brand-soft" : "bg-card text-muted-foreground hover:text-foreground",
                          locked && "cursor-default",
                        )}
                        title={locked ? "Ce canal a déjà son brouillon dans Buffer : il ne se retire plus d'ici." : undefined}
                      >
                        <input type="checkbox" className="sr-only" checked={checked} disabled={locked} onChange={() => toggleChannel(channel)} />
                        <NetworkIcon network={toNetwork(channel.service)} size="xs" />
                        <span className="max-w-44 truncate">{channel.displayName ?? channel.name}</span>
                        {checked && <Check className="size-3.5 text-brand" />}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="text-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="text-title" className="text-sm font-semibold">
                Texte
              </h2>
              {current && selectedChannels.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    update({ texts: { ...doc.texts, ...Object.fromEntries(doc.channelIds.map((id) => [id, doc.texts[current.id] ?? ""])) } });
                    toast.success("Texte copié sur tous les canaux");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Copy className="size-3.5" /> Copier ce texte sur tous les canaux
                </button>
              )}
            </div>
            {!current ? (
              <p className="mt-3 text-sm text-muted-foreground">Choisissez un canal pour écrire son texte.</p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Texte par canal">
                  {selectedChannels.map((channel) => (
                    <button
                      key={channel.id}
                      type="button"
                      role="tab"
                      aria-selected={channel.id === current.id}
                      onClick={() => setActiveChannel(channel.id)}
                      className={cn(
                        "flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                        channel.id === current.id ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <NetworkIcon network={toNetwork(channel.service)} size="xs" />
                      <span className="max-w-32 truncate">{channel.displayName ?? channel.name}</span>
                    </button>
                  ))}
                </div>
                <Label htmlFor="studio-text" className="sr-only">
                  Texte pour {current.displayName ?? current.name}
                </Label>
                <Textarea
                  id="studio-text"
                  value={doc.texts[current.id] ?? ""}
                  onChange={(event) => update({ texts: { ...doc.texts, [current.id]: event.target.value } })}
                  rows={9}
                  placeholder={`Texte pour ${NETWORK_LABELS[toNetwork(current.service)]}…`}
                  className="mt-3 text-base leading-relaxed"
                />
                <p className={cn("mt-1.5 text-right text-xs tabular-nums", currentRules && currentLength > currentRules.maxChars ? "font-semibold text-tone-red" : "text-muted-foreground")} data-testid="char-count">
                  {currentLength} / {currentRules?.maxChars} caractères, hashtags compris
                </p>
              </>
            )}
          </section>

          <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="hashtags-title">
            <h2 id="hashtags-title" className="text-sm font-semibold">
              Hashtags communs
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">Ajoutés à la fin de chaque texte, sauf ceux qu&apos;il contient déjà.</p>
            {doc.hashtags.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5" data-testid="hashtags">
                {doc.hashtags.map((tag) => (
                  <li key={tag} className="flex h-7 items-center gap-1 rounded-full bg-brand-soft pr-1 pl-2.5 text-xs font-medium text-brand">
                    {tag}
                    <button
                      type="button"
                      aria-label={`Retirer ${tag}`}
                      onClick={() => update({ hashtags: doc.hashtags.filter((item) => item !== tag) })}
                      className="flex size-5 items-center justify-center rounded-full outline-none hover:bg-brand/15 focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Label htmlFor="studio-hashtag" className="sr-only">
              Ajouter des hashtags
            </Label>
            <Input
              id="studio-hashtag"
              value={hashtagInput}
              onChange={(event) => setHashtagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  addHashtags(hashtagInput);
                }
              }}
              onBlur={() => hashtagInput.trim() && addHashtags(hashtagInput)}
              placeholder="café, torréfaction, lyon — puis Entrée"
              className="mt-3 h-9"
            />
          </section>

          <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="date-title">
            <h2 id="date-title" className="text-sm font-semibold">
              Date et heure de publication
            </h2>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="studio-day" className="text-xs text-muted-foreground">
                  Jour
                </Label>
                <Input id="studio-day" type="date" value={doc.day} min={dayKeyOf(now, timezone)} onChange={(event) => update({ day: event.target.value })} className="mt-1 h-9 w-44" />
              </div>
              <div>
                <Label htmlFor="studio-time" className="text-xs text-muted-foreground">
                  Heure
                </Label>
                <Input id="studio-time" type="time" value={doc.time} onChange={(event) => update({ time: event.target.value })} className="mt-1 h-9 w-32" />
              </div>
              <p className="pb-2 text-xs text-muted-foreground">Fuseau du client : {timezone}</p>
            </div>
            {conflicts.length > 0 && (
              <ul className="mt-3 grid gap-1.5" data-testid="conflicts">
                {conflicts.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 text-sm text-tone-amber">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    Une autre publication est prévue sur le même canal à {item.dueAt ? formatDateTime(item.dueAt, timezone) : ""} : « {item.title} ».
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="media-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="media-title" className="text-sm font-semibold">
                Médias{selectedMedia.length > 1 ? ` · carrousel de ${selectedMedia.length}` : ""}
              </h2>
              <Button variant="outline" size="lg" onClick={() => setLibraryOpen(true)}>
                <Images /> Bibliothèque
              </Button>
            </div>
            {selectedMedia.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Aucun média. Plusieurs médias forment un carrousel, dans l&apos;ordre affiché.</p>
            ) : (
              <ol className="mt-3 flex flex-wrap gap-3" data-testid="selected-media">
                {selectedMedia.map((asset, index) => (
                  <li key={asset.id} className="w-28">
                    <MediaTile asset={asset} className="aspect-square w-full rounded-xl border" />
                    <div className="mt-1 flex items-center justify-between text-muted-foreground">
                      <button type="button" aria-label={`Avancer ${asset.fileName}`} disabled={index === 0} onClick={() => moveMedia(index, -1)} className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-30">
                        <ArrowLeft className="size-3.5" />
                      </button>
                      <span className="text-xs tabular-nums">{index + 1}</span>
                      <button type="button" aria-label={`Reculer ${asset.fileName}`} disabled={index === selectedMedia.length - 1} onClick={() => moveMedia(index, 1)} className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-30">
                        <ArrowRight className="size-3.5" />
                      </button>
                      <button type="button" aria-label={`Retirer ${asset.fileName}`} onClick={() => update({ mediaIds: doc.mediaIds.filter((id) => id !== asset.id) })} className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:sticky xl:top-20">
          <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="checks-title" data-testid="checks">
            <h2 id="checks-title" className="text-sm font-semibold">
              Contrôles avant envoi
            </h2>
            {issues.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-tone-green">
                <CircleCheck className="size-4 shrink-0" /> Prêt à être envoyé en validation.
              </p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {issues.map((issue, index) => (
                  <li key={`${issue.message}-${index}`} className={cn("flex items-start gap-2 text-sm", issue.level === "error" ? "text-tone-red" : "text-tone-amber")}>
                    {issue.level === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border bg-card p-4 sm:p-5" aria-labelledby="preview-title">
            <h2 id="preview-title" className="text-sm font-semibold">
              Aperçu{current ? ` · ${NETWORK_LABELS[toNetwork(current.service)]}` : ""}
            </h2>
            {preview ? (
              <div className="mt-3 rounded-2xl bg-muted/50 p-3 sm:p-4" data-testid="studio-preview">
                <NetworkPreview post={preview} />
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">L&apos;aperçu apparaît dès qu&apos;un canal est choisi.</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">Aperçu indicatif : le rendu exact dépend de chaque réseau.</p>
          </section>
        </div>
      </div>

      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bibliothèque de {organization.name}</DialogTitle>
            <DialogDescription>Cliquez sur un média pour l&apos;ajouter ou le retirer. L&apos;ordre des clics est l&apos;ordre du carrousel.</DialogDescription>
          </DialogHeader>
          <MediaLibrary
            organizationId={organization.id}
            media={media}
            selectedIds={doc.mediaIds}
            onToggle={(asset) => update({ mediaIds: doc.mediaIds.includes(asset.id) ? doc.mediaIds.filter((id) => id !== asset.id) : [...doc.mediaIds, asset.id] })}
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm === "submit"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={inBuffer > 0 ? "Renvoyer ce contenu en validation ?" : "Envoyer ce contenu en validation ?"}
        confirmLabel={inBuffer > 0 ? "Mettre à jour dans Buffer" : "Créer les brouillons dans Buffer"}
        pending={submitting}
        onConfirm={() => submit()}
      >
        <p>
          {selectedChannels.length} brouillon{selectedChannels.length > 1 ? "s" : ""} {inBuffer > 0 ? "seront mis à jour" : "seront créés"} dans Buffer
          {dueAt ? `, daté${selectedChannels.length > 1 ? "s" : ""} du ${formatDateTime(dueAt, timezone)}` : ""}, puis soumis à {organization.name}.
        </p>
        <p className="mt-2">Rien n&apos;est programmé ni publié : la programmation n&apos;a lieu qu&apos;après l&apos;accord du client.</p>
        {draftId === null && <p className="mt-2">Le contenu sera d&apos;abord enregistré.</p>}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "absent"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Confirmer qu'aucun brouillon n'existe"
        confirmLabel="J'ai vérifié, autoriser le renvoi"
        destructive
        pending={submitting}
        disabled={evidence.trim().length < 10}
        onConfirm={() => confirmAbsent()}
      >
        <p>Cadence ne peut pas prouver qu&apos;un brouillon n&apos;existe pas dans Buffer. Ouvrez Buffer et vérifiez les brouillons de ce client sur ce canal : s&apos;il existe déjà, supprimez-le là-bas avant de renvoyer, sinon il serait en double.</p>
        <p>Cette confirmation est une dérogation à la protection automatique contre les doublons : elle vaut pour cette tentative seulement, et un risque de doublon subsiste si votre vérification était incomplète.</p>
        <div className="grid gap-1.5">
          <Label htmlFor="absence-evidence">Ce que vous avez vérifié (consigné avec la tentative)</Label>
          <Textarea
            id="absence-evidence"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            maxLength={500}
            placeholder="Ex. : brouillons du canal LinkedIn ouverts dans Buffer le 10/10 à 14 h, aucun à ce texte ni à cette date."
            data-testid="absence-evidence"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
