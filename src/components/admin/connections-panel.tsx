"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Plug, PlugZap, Plus, ShieldOff } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { leaveIfExpired, type ActionResult } from "@/lib/action-result";
import { connectionStatus, credentialLabel, type ConnectionSummary } from "@/lib/domain/connections";
import { createMockConnection, createRealConnection, replaceConnectionCredential, revokeConnection } from "@/server/connection-actions";

const SHARED = "shared";

const TONE: Record<string, string> = {
  green: "bg-tone-green-soft text-tone-green",
  amber: "bg-tone-amber-soft text-tone-amber",
  red: "bg-tone-red-soft text-tone-red",
  muted: "bg-muted text-muted-foreground",
};

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[tone]}`}>{children}</span>;
}

const dateTime = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso)) : "jamais";

/**
 * Comptes Buffer (« connexions ») : ceux d'un client quand `organizationId` est fourni, tous sinon.
 * Aucune clé n'est jamais affichée : seulement un indice de quatre caractères. Une connexion réelle enregistrée
 * alors que le serveur est en mode simulé est montrée comme « enregistrée, non utilisée », jamais comme active.
 */
export function ConnectionsPanel({
  connections,
  organizations,
  serverMode,
  canStoreKeys,
  organizationId,
}: {
  connections: ConnectionSummary[];
  organizations: { id: string; name: string }[];
  serverMode: "real" | "mock";
  canStoreKeys: boolean;
  /** Fiche d'un client : la connexion créée lui appartient, sans choix possible. */
  organizationId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<"mock" | "real">("mock");
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState<string>(organizationId ?? SHARED);
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState<ConnectionSummary | null>(null);
  const [revoking, setRevoking] = useState<{ connection: ConnectionSummary; forced: boolean } | null>(null);

  const nameOf = (id: string | null) => (id ? (organizations.find((item) => item.id === id)?.name ?? "Client archivé") : "Partagée (agence)");

  const run = (action: () => Promise<ActionResult>, done?: (result: ActionResult) => void) =>
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
    setKind("mock");
    setOwner(organizationId ?? SHARED);
  };

  const submitCreate = () => {
    const target = owner === SHARED ? null : owner;
    run(
      () => (kind === "mock" ? createMockConnection({ organizationId: target, label }) : createRealConnection({ organizationId: target, label, apiKey })),
      (result) => {
        // La clé saisie ne reste jamais dans la page après l'envoi.
        setApiKey("");
        if (result.ok) closeCreate();
      },
    );
  };

  return (
    <div className="grid grid-cols-1 gap-3">
      {connections.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
          {organizationId ? "Ce client n'a pas de compte Buffer qui lui soit propre." : "Aucune connexion enregistrée."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {connections.map((connection) => {
            const status = connectionStatus(connection, serverMode);
            const open = connection.unresolved.scheduled + connection.unresolved.pending + connection.unresolved.uncertain;
            return (
              <li key={connection.id} data-connection={connection.id} className="rounded-2xl border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {connection.mode === "mock" ? <Plug className="size-4 shrink-0 text-muted-foreground" /> : <PlugZap className="size-4 shrink-0 text-muted-foreground" />}
                      <span className="truncate">{connection.label}</span>
                      <Badge tone={connection.mode === "mock" ? "amber" : "muted"}>{connection.mode === "mock" ? "Simulé" : "Buffer réel"}</Badge>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {nameOf(connection.organizationId)} · {credentialLabel(connection)} · {connection.channels} canal{connection.channels > 1 ? "x" : ""} · dernière lecture : {dateTime(connection.lastSyncAt)}
                    </p>
                    {status.detail && <p className="mt-1 text-xs text-muted-foreground">{status.detail}</p>}
                    {connection.lastError && connection.status === "active" && <p className="mt-1 text-xs text-tone-red">Dernière erreur : {connection.lastError}</p>}
                    {open > 0 && (
                      <p className="mt-1 text-xs text-tone-amber">
                        En attente sur ce compte : {connection.unresolved.scheduled} programmée(s), {connection.unresolved.pending} opération(s) en cours, {connection.unresolved.uncertain} envoi(s) incertain(s).
                      </p>
                    )}
                  </div>
                  {connection.status === "active" && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {connection.mode === "real" && (
                        <Button variant="outline" size="sm" disabled={pending || !canStoreKeys} onClick={() => setReplacing(connection)}>
                          <KeyRound className="size-3.5" />
                          Remplacer la clé
                        </Button>
                      )}
                      {!(connection.isDefault && connection.mode === "mock") && (
                        <Button variant="outline" size="sm" disabled={pending} onClick={() => setRevoking({ connection, forced: false })}>
                          <ShieldOff className="size-3.5" />
                          Révoquer
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          Ajouter une connexion Buffer
        </Button>
      </div>

      <Dialog open={creating} onOpenChange={(next) => (next ? setCreating(true) : closeCreate())}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ajouter une connexion Buffer</DialogTitle>
            <DialogDescription>
              Une connexion correspond à un compte Buffer. Ses canaux lui restent liés pour toujours : aucune publication ne peut partir par un autre compte.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="connection-kind">Type de compte</Label>
              <Select value={kind} onValueChange={(value) => setKind(value as "mock" | "real")}>
                <SelectTrigger id="connection-kind" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mock">Compte simulé (aucun appel à Buffer)</SelectItem>
                  <SelectItem value="real" disabled={!canStoreKeys}>Compte Buffer réel (clé d&apos;API)</SelectItem>
                </SelectContent>
              </Select>
              {!canStoreKeys && <p className="text-xs text-muted-foreground">Compte réel indisponible : le serveur n&apos;a pas de clé de chiffrement (CADENCE_CREDENTIALS_KEY).</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="connection-label">Nom de la connexion</Label>
              <Input id="connection-label" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Buffer de Maison Colibri" autoComplete="off" />
            </div>
            {!organizationId && (
              <div className="grid gap-1.5">
                <Label htmlFor="connection-owner">Client propriétaire du compte</Label>
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger id="connection-owner" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SHARED}>Partagée (compte de l&apos;agence)</SelectItem>
                    {organizations.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Les canaux d&apos;un compte appartenant à un client ne peuvent être attribués qu&apos;à ce client.</p>
              </div>
            )}
            {kind === "real" && (
              <div className="grid gap-1.5">
                <Label htmlFor="connection-key">Clé d&apos;API Buffer</Label>
                <Input id="connection-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} />
                <p className="text-xs text-muted-foreground">
                  Chiffrée par le serveur avant enregistrement, jamais réaffichée. {serverMode === "mock" ? "Le serveur est en mode simulé : cette connexion restera inutilisée et aucun appel à Buffer n'aura lieu." : "Elle sera utilisée dès la prochaine synchronisation."}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreate} disabled={pending}>Annuler</Button>
            <Button onClick={submitCreate} disabled={pending || label.trim().length === 0 || (kind === "real" && apiKey.trim().length < 16)}>
              {pending ? "En cours…" : "Créer la connexion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={replacing !== null} onOpenChange={(next) => { if (!next) { setReplacing(null); setApiKey(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remplacer la clé de « {replacing?.label} »</DialogTitle>
            <DialogDescription>
              À utiliser pour une nouvelle clé du MÊME compte Buffer. Pour un autre compte, créez une nouvelle connexion : les publications déjà programmées restent ainsi rattachées à leur compte d&apos;origine.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="connection-new-key">Nouvelle clé d&apos;API</Label>
            <Input id="connection-new-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReplacing(null); setApiKey(""); }} disabled={pending}>Annuler</Button>
            <Button
              disabled={pending || apiKey.trim().length < 16}
              onClick={() => replacing && run(() => replaceConnectionCredential({ connectionId: replacing.id, apiKey }), (result) => { setApiKey(""); if (result.ok) setReplacing(null); })}
            >
              {pending ? "En cours…" : "Remplacer la clé"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => { if (!next) setRevoking(null); }}
        title={revoking?.forced ? "Révoquer malgré des opérations en attente ?" : `Révoquer « ${revoking?.connection.label ?? ""} » ?`}
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
              if (result.ok) {
                toast.success(result.message);
                setRevoking(null);
                router.refresh();
              } else if (result.unresolved && !forced) {
                toast.error(result.message);
                setRevoking({ connection, forced: true });
              } else {
                toast.error(result.message);
              }
            } catch {
              toast.error("La connexion a été interrompue. Rechargez la page avant de réessayer.");
            }
          });
        }}
      >
        {revoking?.forced ? (
          <p>
            Des publications programmées, des opérations en cours ou des envois incertains dépendent encore de ce compte. Après la révocation, Cadence ne pourra plus les annuler ni les vérifier dans Buffer :
            vous devrez le faire vous-même dans Buffer. Cette décision est consignée au journal.
          </p>
        ) : (
          <p>Plus aucune opération ne passera par ce compte et sa clé sera effacée. Ses canaux et l&apos;historique de ses publications restent visibles. Une connexion révoquée ne se réactive pas.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
