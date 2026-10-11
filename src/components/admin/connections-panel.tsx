"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, ChevronDown, KeyRound, Plug, PlugZap, Plus, ShieldOff, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { leaveIfExpired, type ActionResult } from "@/lib/action-result";
import {
  connectionStatus, credentialLabel, pushStateLabel, scheduleStateLabel, type ConnectionDetail, type ConnectionSummary,
} from "@/lib/domain/connections";
import {
  cancelRevocation, connectionDetail, createMockConnection, createRealConnection, replaceConnectionCredential, revokeConnection, verifyConnection,
} from "@/server/connection-actions";

const SHARED = "shared";

const TONE: Record<string, string> = {
  green: "bg-tone-green-soft text-tone-green",
  amber: "bg-tone-amber-soft text-tone-amber",
  red: "bg-tone-red-soft text-tone-red",
  muted: "bg-muted text-muted-foreground",
};

/** Cible tactile d'au moins 44 px sur mobile, compacte au-delà. */
const TOUCH = "min-h-11 sm:min-h-8";

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[tone]}`}>{children}</span>;
}

const dateTime = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso)) : "jamais";

const WINDOWS: Record<string, string> = { "15min": "15 min", "24h": "24 h", "30d": "30 jours" };
/** « 100-in-15min » → « 62 sur 100 (15 min) ». */
function quotaLines(rateLimit: Record<string, number> | null): string[] {
  return Object.entries(rateLimit ?? {}).flatMap(([key, remaining]) => {
    const match = key.match(/^(\d+)-in-(.+)$/);
    return match ? [`${remaining} sur ${match[1]} (${WINDOWS[match[2]] ?? match[2]})`] : [];
  });
}

/**
 * Comptes Buffer (« connexions ») : ceux d'un client quand `organizationId` est fourni, tous sinon.
 * Aucune clé n'est jamais affichée : seulement un indice de quatre caractères. Chaque état montré est lu en base ;
 * une connexion réelle sur un serveur en simulation, ou une clé jamais vérifiée, n'est jamais présentée comme active.
 */
export function ConnectionsPanel({
  connections,
  organizations,
  serverMode,
  canStoreKeys,
  writesEnabled,
  organizationId,
}: {
  connections: ConnectionSummary[];
  organizations: { id: string; name: string }[];
  serverMode: "real" | "mock";
  canStoreKeys: boolean;
  /** Barrière d'activation des écritures vers le vrai Buffer (sans objet en simulation). */
  writesEnabled: boolean;
  /** Fiche d'un client : la connexion créée lui appartient, sans choix possible. */
  organizationId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const simulated = serverMode === "mock";
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<"mock" | "real">(simulated ? "mock" : "real");
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState<string>(organizationId ?? SHARED);
  const [apiKey, setApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<ConnectionSummary | null>(null);
  const [revoking, setRevoking] = useState<{ connection: ConnectionSummary; forced: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ConnectionDetail>>({});
  const [verified, setVerified] = useState<Record<string, { label: string; channels: { service: string; name: string; isDisconnected: boolean }[] }>>({});

  const nameOf = (id: string | null) => (id ? (organizations.find((item) => item.id === id)?.name ?? "Client archivé") : "Partagée (agence)");

  const run = <T extends ActionResult>(action: () => Promise<T>, done?: (result: T) => void) =>
    startTransition(async () => {
      try {
        const result = await action();
        if (leaveIfExpired(result)) return;
        if (result.ok) toast.success(result.message);
        else toast.error(result.message);
        done?.(result);
        if (result.ok) router.refresh();
      } catch {
        toast.error("La connexion a été interrompue. Rechargez la page avant de réessayer.");
      }
    });

  const closeCreate = () => {
    setCreating(false);
    setLabel("");
    setApiKey("");
    setFormError(null);
    setKind(simulated ? "mock" : "real");
    setOwner(organizationId ?? SHARED);
  };

  const submitCreate = () => {
    const target = owner === SHARED ? null : owner;
    setFormError(null);
    run(
      () => (kind === "mock" ? createMockConnection({ organizationId: target, label }) : createRealConnection({ organizationId: target, label, apiKey })),
      (result) => {
        // La clé saisie ne reste pas dans la page une fois enregistrée ; après un refus, elle reste pour être corrigée.
        if (result.ok) closeCreate();
        else setFormError(result.message);
      },
    );
  };

  const toggleDetail = (connection: ConnectionSummary) => {
    if (open === connection.id) return setOpen(null);
    setOpen(connection.id);
    startTransition(async () => {
      try {
        const result = await connectionDetail({ connectionId: connection.id });
        if (leaveIfExpired(result)) return;
        if (result.ok && result.detail) setDetails((current) => ({ ...current, [connection.id]: result.detail! }));
        else toast.error(result.message || "Détail indisponible.");
      } catch {
        toast.error("La connexion a été interrompue. Rechargez la page avant de réessayer.");
      }
    });
  };

  const createDisabledReason =
    label.trim().length === 0 ? "Donnez un nom à la connexion."
      : kind === "real" && apiKey.trim().length < 16 ? "La clé doit compter au moins 16 caractères, sans espace."
        : null;

  return (
    <div className="grid grid-cols-1 gap-3">
      {connections.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="aucun-compte-buffer">
          <p className="font-semibold text-foreground">Aucun compte Buffer connecté</p>
          <p className="mt-1">
            {organizationId
              ? "Ce client n'a pas de compte Buffer qui lui soit propre : ses publications ne peuvent être ni lues ni envoyées."
              : "Aucune connexion n'est enregistrée : rien n'est lu ni envoyé."}
            {" "}Ajoutez sa connexion ci-dessous.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {connections.map((connection) => {
            const status = connectionStatus(connection, serverMode);
            const waiting = connection.unresolved.scheduled + connection.unresolved.pending + connection.unresolved.uncertain;
            const detail = details[connection.id];
            const seen = verified[connection.id];
            const quota = quotaLines(connection.rateLimit);
            const live = connection.status !== "revoked";
            return (
              <li key={connection.id} data-connection={connection.id} data-status={connection.status} className="rounded-2xl border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {connection.mode === "mock" ? <Plug className="size-4 shrink-0 text-muted-foreground" /> : <PlugZap className="size-4 shrink-0 text-muted-foreground" />}
                      <span className="truncate">{connection.label}</span>
                      <Badge tone={connection.mode === "mock" ? "amber" : "muted"}>{connection.mode === "mock" ? "Simulé" : "Buffer réel"}</Badge>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </p>
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <div><dt className="inline font-medium text-foreground">Client : </dt><dd className="inline">{nameOf(connection.organizationId)}</dd></div>
                      {connection.mode === "real" && (
                        <div>
                          <dt className="inline font-medium text-foreground">Compte Buffer : </dt>
                          <dd className="inline">{connection.accountLabel ?? (connection.verified ? "constaté" : "non vérifié")}</dd>
                        </div>
                      )}
                      <div><dt className="inline font-medium text-foreground">Clé : </dt><dd className="inline">{credentialLabel(connection)}</dd></div>
                      <div><dt className="inline font-medium text-foreground">Réseaux : </dt><dd className="inline">{connection.channels} {connection.channels > 1 ? "canaux" : "canal"}</dd></div>
                      <div><dt className="inline font-medium text-foreground">Dernière synchronisation : </dt><dd className="inline">{dateTime(connection.lastSyncAt)}</dd></div>
                      {connection.mode === "real" && (
                        <div><dt className="inline font-medium text-foreground">Dernière vérification : </dt><dd className="inline">{dateTime(connection.lastVerifiedAt)}</dd></div>
                      )}
                      {quota.length > 0 && <div className="sm:col-span-2"><dt className="inline font-medium text-foreground">Requêtes restantes : </dt><dd className="inline">{quota.join(" · ")}</dd></div>}
                    </dl>
                    {status.detail && <p className="mt-2 text-xs text-muted-foreground">{status.detail}</p>}
                    {connection.readBackoffUntil && live && (
                      <p className="mt-1 text-xs text-tone-amber">Quota presque épuisé : lectures planifiées de ce compte espacées jusqu&apos;au {dateTime(connection.readBackoffUntil)}. Écritures et annulations restent possibles.</p>
                    )}
                    {connection.lastError && live && <p className="mt-1 text-xs text-tone-red" role="status">Dernière erreur : {connection.lastError}</p>}
                    {waiting > 0 && (
                      <p className="mt-1 text-xs text-tone-amber">
                        Encore suivi sur ce compte : {connection.unresolved.scheduled} publication(s) programmée(s) dans Buffer{connection.unresolved.pending + connection.unresolved.uncertain > 0 ? `, ${connection.unresolved.pending + connection.unresolved.uncertain} opération(s) héritée(s) à rapprocher` : ""}.
                      </p>
                    )}
                    {connection.mode === "real" && live && serverMode === "real" && !writesEnabled && (
                      <p className="mt-1 text-xs text-muted-foreground">La programmation après accord est désactivée sur ce serveur : ce compte est seulement lu.</p>
                    )}
                    {seen && (
                      <div className="mt-2 rounded-xl bg-muted/60 p-3 text-xs" data-testid="compte-constate">
                        <p className="font-medium text-foreground">Compte constaté à l&apos;instant : {seen.label}</p>
                        <ul className="mt-1 grid grid-cols-1 gap-0.5 text-muted-foreground">
                          {seen.channels.length === 0 && <li>Aucun réseau social relié à ce compte Buffer.</li>}
                          {seen.channels.map((channel, index) => (
                            <li key={`${channel.service}-${index}`}>{channel.service} — {channel.name}{channel.isDisconnected ? " (déconnecté dans Buffer)" : ""}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button variant="outline" size="sm" className={TOUCH} aria-expanded={open === connection.id} onClick={() => toggleDetail(connection)}>
                      <ChevronDown className={`size-3.5 transition-transform ${open === connection.id ? "rotate-180" : ""}`} />
                      Détails
                    </Button>
                    {live && connection.mode === "real" && (
                      <Button
                        variant="outline" size="sm" className={TOUCH} disabled={pending || simulated}
                        title={simulated ? "Le serveur est en simulation : il n'appelle pas Buffer." : undefined}
                        onClick={() => run(() => verifyConnection({ connectionId: connection.id }), (result) => {
                          if (result.ok && result.account) setVerified((current) => ({ ...current, [connection.id]: result.account! }));
                        })}
                      >
                        <BadgeCheck className="size-3.5" />
                        Vérifier
                      </Button>
                    )}
                    {connection.status === "active" && connection.mode === "real" && connection.credentialSource !== "environment" && (
                      <Button variant="outline" size="sm" className={TOUCH} disabled={pending || !canStoreKeys} title={canStoreKeys ? undefined : "Le serveur n'a pas de clé de chiffrement."} onClick={() => { setFormError(null); setReplacing(connection); }}>
                        <KeyRound className="size-3.5" />
                        Remplacer la clé
                      </Button>
                    )}
                    {connection.status === "revoking" && (
                      <Button variant="outline" size="sm" className={TOUCH} disabled={pending} onClick={() => run(() => cancelRevocation({ connectionId: connection.id }))}>
                        <Undo2 className="size-3.5" />
                        Annuler la demande
                      </Button>
                    )}
                    {live && !(connection.isDefault && connection.mode === "mock") && (
                      <Button variant="outline" size="sm" className={TOUCH} disabled={pending} onClick={() => setRevoking({ connection, forced: connection.status === "revoking" && waiting > 0 })}>
                        <ShieldOff className="size-3.5" />
                        {connection.status === "revoking" ? (waiting > 0 ? "Révoquer quand même" : "Terminer la révocation") : "Révoquer"}
                      </Button>
                    )}
                  </div>
                </div>

                {open === connection.id && (
                  <div className="mt-4 grid grid-cols-1 gap-4 border-t pt-4 text-xs lg:grid-cols-3" data-testid="detail-connexion">
                    {!detail ? (
                      <p className="text-muted-foreground lg:col-span-3">Chargement…</p>
                    ) : (
                      <>
                        <section>
                          <h4 className="font-semibold text-foreground">Réseaux sociaux connectés ({detail.channels.length})</h4>
                          {detail.channels.length === 0 ? (
                            <p className="mt-1 text-muted-foreground">Aucun pour l&apos;instant : ils apparaissent à la première synchronisation réussie de ce compte.</p>
                          ) : (
                            <ul className="mt-1 grid grid-cols-1 gap-1 text-muted-foreground">
                              {detail.channels.map((channel) => (
                                <li key={channel.id} className="break-words">
                                  <span className="font-medium text-foreground">{channel.service}</span> — {channel.name}
                                  {channel.isDisconnected ? " · déconnecté dans Buffer" : ""}
                                  {channel.organizationId ? ` · ${nameOf(channel.organizationId)}` : " · non attribué"}
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                        <section>
                          <h4 className="font-semibold text-foreground">Programmations en attente ({detail.scheduled.length})</h4>
                          {detail.scheduled.length === 0 ? (
                            <p className="mt-1 text-muted-foreground">Aucune.</p>
                          ) : (
                            <ul className="mt-1 grid grid-cols-1 gap-1.5 text-muted-foreground">
                              {detail.scheduled.map((item) => (
                                <li key={item.id} className="break-words">
                                  <span className="font-medium text-foreground">{dateTime(item.dueAt)}</span> · {item.service} — {item.channel}
                                  <br />{scheduleStateLabel(item.scheduleState, item.bufferStatus)}
                                  {item.error ? ` · ${item.error}` : ""}
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                        <section>
                          <h4 className="font-semibold text-foreground">Envois non résolus ({detail.uncertain.length})</h4>
                          {detail.uncertain.length === 0 ? (
                            <p className="mt-1 text-muted-foreground">Aucun.</p>
                          ) : (
                            <ul className="mt-1 grid grid-cols-1 gap-1.5 text-muted-foreground">
                              {detail.uncertain.map((item) => (
                                <li key={item.variantId} className="break-words">
                                  <span className="font-medium text-foreground">{item.service} — {item.channel}</span>
                                  <br />{pushStateLabel(item.pushState, item.orphans)}
                                  {item.attemptId && <><br />Tentative <code className="font-mono">{item.attemptId}</code></>}
                                  {item.claimedAt ? ` · ${dateTime(item.claimedAt)}` : ""}
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <Button variant="outline" size="sm" className={TOUCH} onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          {simulated ? "Ajouter une connexion Buffer" : "Connecter un compte Buffer"}
        </Button>
      </div>

      <Dialog open={creating} onOpenChange={(next) => (next ? setCreating(true) : closeCreate())}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{simulated ? "Ajouter une connexion Buffer" : "Connecter un compte Buffer"}</DialogTitle>
            <DialogDescription>
              Une connexion correspond à un compte Buffer, relié par sa clé d&apos;API. Ses canaux lui restent liés : aucune publication ne peut partir par un autre compte.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3">
            {simulated && (
              <div className="grid grid-cols-1 gap-1.5">
                <Label htmlFor="connection-kind">Type de compte</Label>
                <Select value={kind} onValueChange={(value) => setKind(value as "mock" | "real")}>
                  <SelectTrigger id="connection-kind" className="min-h-11 w-full sm:min-h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mock">Compte simulé (aucun appel à Buffer)</SelectItem>
                    <SelectItem value="real" disabled={!canStoreKeys}>Compte Buffer réel (clé d&apos;API)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {!canStoreKeys && <p className="text-xs text-tone-red">Compte réel indisponible : le serveur n&apos;a pas de clé de chiffrement (CADENCE_CREDENTIALS_KEY).</p>}
            <div className="grid grid-cols-1 gap-1.5">
              <Label htmlFor="connection-label">Nom de la connexion</Label>
              <Input id="connection-label" className="min-h-11 sm:min-h-8" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Buffer du client" autoComplete="off" />
            </div>
            {!organizationId && (
              <div className="grid grid-cols-1 gap-1.5">
                <Label htmlFor="connection-owner">Client propriétaire du compte</Label>
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger id="connection-owner" className="min-h-11 w-full sm:min-h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SHARED}>Partagée (compte de l&apos;agence)</SelectItem>
                    {organizations.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Les canaux d&apos;un compte appartenant à un client ne peuvent être attribués qu&apos;à ce client.</p>
              </div>
            )}
            {kind === "real" && (
              <div className="grid grid-cols-1 gap-1.5">
                <Label htmlFor="connection-key">Clé d&apos;API Buffer</Label>
                <Input id="connection-key" className="min-h-11 sm:min-h-8" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} />
                <p className="text-xs text-muted-foreground">
                  Elle se crée dans Buffer, par le titulaire du compte, dans les réglages (Settings → API). Chiffrée par le serveur avant enregistrement, jamais réaffichée.{" "}
                  {simulated
                    ? "Le serveur est en simulation : aucun appel à Buffer n'a lieu, la clé sera enregistrée « non vérifiée » et restera inutilisable."
                    : "Avant de l'enregistrer, Cadence demande à Buffer à quel compte elle appartient (lecture seule). Une clé refusée n'est pas enregistrée."}
                </p>
              </div>
            )}
            {formError && <p role="alert" className="rounded-lg bg-tone-red-soft px-3 py-2 text-xs text-tone-red">{formError}</p>}
            {createDisabledReason && !pending && <p className="text-xs text-muted-foreground">{createDisabledReason}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" className={TOUCH} onClick={closeCreate} disabled={pending}>Annuler</Button>
            <Button className={TOUCH} onClick={submitCreate} disabled={pending || createDisabledReason !== null || (kind === "real" && !canStoreKeys)}>
              {pending ? (kind === "real" && !simulated ? "Vérification…" : "En cours…") : kind === "real" && !simulated ? "Vérifier et connecter" : "Créer la connexion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={replacing !== null} onOpenChange={(next) => { if (!next) { setReplacing(null); setApiKey(""); setFormError(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remplacer la clé de « {replacing?.label} »</DialogTitle>
            <DialogDescription>
              Pour une nouvelle clé du même compte Buffer{replacing?.accountLabel ? ` (${replacing.accountLabel})` : ""}. {simulated
                ? "Le serveur est en simulation : la clé ne peut pas être vérifiée."
                : "Cadence vérifie auprès de Buffer qu'elle appartient bien à ce compte ; sinon, l'ancienne clé reste en place."}
              {" "}Pour un autre compte, créez une nouvelle connexion : les publications déjà programmées restent rattachées à leur compte d&apos;origine.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor="connection-new-key">Nouvelle clé d&apos;API</Label>
            <Input id="connection-new-key" className="min-h-11 sm:min-h-8" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} />
            {waitingOf(replacing) > 0 && (
              <p className="text-xs text-tone-amber">Des opérations sont en attente sur ce compte : elles continueront avec la nouvelle clé, sur le même compte.</p>
            )}
            {formError && <p role="alert" className="rounded-lg bg-tone-red-soft px-3 py-2 text-xs text-tone-red">{formError}</p>}
            {apiKey.trim().length < 16 && !pending && <p className="text-xs text-muted-foreground">La clé doit compter au moins 16 caractères, sans espace.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" className={TOUCH} onClick={() => { setReplacing(null); setApiKey(""); setFormError(null); }} disabled={pending}>Annuler</Button>
            <Button
              className={TOUCH}
              disabled={pending || apiKey.trim().length < 16}
              onClick={() => {
                if (!replacing) return;
                setFormError(null);
                run(() => replaceConnectionCredential({ connectionId: replacing.id, apiKey }), (result) => {
                  if (result.ok) { setApiKey(""); setReplacing(null); } else setFormError(result.message);
                });
              }}
            >
              {pending ? (simulated ? "En cours…" : "Vérification…") : simulated ? "Remplacer la clé" : "Vérifier et remplacer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => { if (!next) setRevoking(null); }}
        title={revoking?.forced ? "Révoquer malgré des publications encore suivies ?" : "Révoquer cette connexion ?"}
        confirmLabel={revoking?.forced ? "Révoquer quand même" : "Révoquer la connexion"}
        destructive
        phrase={revoking?.forced ? "révoquer" : undefined}
        pending={pending}
        onConfirm={() => {
          if (!revoking) return;
          const { connection, forced } = revoking;
          startTransition(async () => {
            try {
              const result = await revokeConnection({ connectionId: connection.id, force: forced });
              if (leaveIfExpired(result)) return;
              if (result.ok) toast.success(result.message);
              else if (result.revoking) toast.message(result.message);
              else toast.error(result.message);
              if (result.ok || result.revoking) {
                setRevoking(null);
                router.refresh();
              }
            } catch {
              toast.error("La connexion a été interrompue. Rechargez la page avant de réessayer.");
            }
          });
        }}
      >
        {revoking?.forced ? (
          <p>
            Des publications de ce compte sont encore programmées dans Buffer. La révocation efface sa clé : Cadence ne pourra plus les suivre (publication, modification, retour en brouillon).
            Rien ne change dans Buffer : elles y restent programmées. Cette décision est consignée au journal.
          </p>
        ) : (
          <p>
            Cadence cessera de lire ce compte Buffer. S&apos;il y reste des publications programmées, la révocation sera d&apos;abord « demandée » : la clé est conservée pour continuer à les suivre jusqu&apos;à leur publication,
            puis effacée ; vous pourrez aussi la terminer tout de suite. Rien ne change dans Buffer. Les canaux et l&apos;historique des publications restent visibles. Une connexion révoquée ne se réactive pas.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

const waitingOf = (connection: ConnectionSummary | null) =>
  connection ? connection.unresolved.scheduled + connection.unresolved.pending + connection.unresolved.uncertain : 0;
