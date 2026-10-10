"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ArrowLeft, ArrowRight, Inbox, Pencil, Radio, UserMinus, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";

import { ChannelRow } from "@/components/admin/channel-row";
import { ClientFormDialog } from "@/components/admin/client-form-dialog";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { PostCard } from "@/components/publications/post-card";
import { OrgAvatar, PersonAvatar } from "@/components/shared/org-avatar";
import { EmptyState } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { useAdmin } from "@/components/shell/admin-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { leaveIfExpired, type ActionResult } from "@/lib/action-result";
import { isArchived, sortChannels } from "@/lib/domain/clients";
import { DISPLAY_STATUSES, type Channel, type Organization, type Profile } from "@/lib/types";
import type { PostView } from "@/lib/view";
import { addUserByEmail, assignChannel, setMember, setOrganizationArchived } from "@/server/actions";

const PRIORITY = ["pending_approval", "changes_requested", "error", "approved", "scheduled", "draft", "published"];

/** Exécute une action serveur et affiche son résultat. Renvoie true si elle a réussi. */
async function run(action: () => Promise<ActionResult>): Promise<boolean> {
  try {
    const result = await action();
    if (leaveIfExpired(result)) return false;
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
    return result.ok;
  } catch {
    toast.error("La connexion a été interrompue. Rechargez la page avant de réessayer.");
    return false;
  }
}

function Card({ title, icon: Icon, count, children, id }: { title: string; icon: React.ComponentType<{ className?: string }>; count?: number; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="grid grid-cols-1 content-start gap-3">
      <h2 id={id} className="flex items-center gap-2 font-display text-xl font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {title}
        {count !== undefined && <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-xs font-medium text-muted-foreground">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function MembersPanel({ organization, users, candidates, emails }: { organization: Organization; users: Profile[]; candidates: Profile[]; emails: Record<string, string> }) {
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState<Profile | null>(null);
  const [existing, setExisting] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [jobTitle, setJobTitle] = useState("");

  const addExisting = () =>
    startTransition(async () => {
      if (await run(() => setMember({ organizationId: organization.id, userId: existing, member: true }))) setExisting("");
    });
  const addByEmail = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      if (await run(() => addUserByEmail({ organizationId: organization.id, email, fullName, jobTitle }))) {
        setEmail("");
        setFullName("");
        setJobTitle("");
      }
    });
  };

  return (
    <Card title="Utilisateurs" icon={Users} count={users.length} id="membres-title">
      <div className="overflow-hidden rounded-2xl border bg-card">
        {users.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Aucun utilisateur n&apos;a accès à l&apos;espace de ce client.</p>
        ) : (
          <ul>
            {users.map((user) => (
              <li key={user.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0" data-member={emails[user.id] ?? user.id}>
                <PersonAvatar profile={user} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{user.fullName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[user.jobTitle, emails[user.id]].filter(Boolean).join(" · ") || "Client"}</span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(user)} disabled={pending} aria-label={`Retirer l'accès de ${user.fullName}`}>
                  <UserMinus />
                  <span className="max-sm:sr-only">Retirer</span>
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-4 border-t bg-muted/40 px-4 py-4">
          {candidates.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="member-existing">Associer un utilisateur déjà connu</Label>
              <div className="flex flex-wrap gap-2">
                <Select value={existing} onValueChange={setExisting}>
                  <SelectTrigger id="member-existing" className="h-9! min-w-0 flex-1 basis-48 bg-card">
                    <SelectValue placeholder="Choisir un utilisateur" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.fullName}
                        {emails[profile.id] ? ` — ${emails[profile.id]}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="lg" onClick={addExisting} disabled={!existing || pending}>
                  Associer
                </Button>
              </div>
            </div>
          )}

          <form onSubmit={addByEmail} className="grid gap-2">
            <Label htmlFor="member-email">Donner accès à un nouveau compte</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input id="member-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="adresse@exemple.fr" required className="h-9 bg-card sm:col-span-2" />
              <Input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Prénom et nom" aria-label="Prénom et nom" maxLength={80} className="h-9 bg-card" />
              <Input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} placeholder="Fonction (facultatif)" aria-label="Fonction" maxLength={80} className="h-9 bg-card" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="max-w-md text-xs text-muted-foreground">
                Le compte doit d&apos;abord exister : dans Supabase → Authentication → Users, « Invite user » lui envoie l&apos;e-mail d&apos;invitation.
              </p>
              <Button type="submit" variant="outline" size="lg" disabled={pending || !email}>
                <UserPlus />
                Donner accès
              </Button>
            </div>
          </form>
        </div>
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Retirer l'accès de ${removing?.fullName ?? ""} ?`}
        confirmLabel="Retirer l'accès"
        destructive
        pending={pending}
        onConfirm={() =>
          removing &&
          startTransition(async () => {
            await run(() => setMember({ organizationId: organization.id, userId: removing.id, member: false }));
            setRemoving(null);
          })
        }
      >
        <p>
          Cette personne ne verra plus les publications de {organization.name}. Ses commentaires et décisions passés sont conservés, et son compte n&apos;est pas supprimé.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

/** Administration → Clients → Fiche client : informations, canaux, utilisateurs et publications. */
export function ClientDetail({
  organization,
  organizations,
  channels,
  posts,
  profiles,
  members,
  emails,
}: {
  organization: Organization;
  organizations: Organization[];
  channels: Channel[];
  posts: PostView[];
  profiles: Profile[];
  members: { organizationId: string; userId: string }[];
  emails: Record<string, string>;
}) {
  const router = useRouter();
  const { setOrgFilter } = useAdmin();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [toAdd, setToAdd] = useState("");
  const archived = isArchived(organization);

  const ownChannels = sortChannels(channels.filter((channel) => channel.organizationId === organization.id));
  const freeChannels = sortChannels(channels.filter((channel) => !channel.organizationId));
  const memberIds = new Set(members.filter((member) => member.organizationId === organization.id).map((member) => member.userId));
  const users = profiles.filter((profile) => memberIds.has(profile.id));
  const candidates = profiles.filter((profile) => profile.role === "client" && !memberIds.has(profile.id));
  const ownPosts = posts.filter((post) => post.organization?.id === organization.id);
  const latest = [...ownPosts].sort((a, b) => PRIORITY.indexOf(a.status) - PRIORITY.indexOf(b.status)).slice(0, 6);
  const postCount = (channel: Channel) => posts.filter((post) => post.channelId === channel.id).length;

  const archive = (value: boolean) =>
    startTransition(async () => {
      await run(() => setOrganizationArchived({ id: organization.id, archived: value }));
      setArchiving(false);
    });
  const addChannel = () =>
    startTransition(async () => {
      // Un canal libre qui a appartenu à un autre client est un transfert : sa ligne, plus bas dans la liste générale, demande la confirmation.
      const ok = await run(async () => {
        const result = await assignChannel({ channelId: toAdd, organizationId: organization.id });
        return result.needsConfirmation ? { ok: false, message: "Ce canal a appartenu à un autre client : transférez-le depuis la liste des canaux de la page Clients, qui demande une confirmation." } : result;
      });
      if (ok) setToAdd("");
    });

  return (
    <div className="grid animate-rise grid-cols-1 gap-8">
      <div className="grid grid-cols-1 gap-4">
        <Link href="/admin/clients" className="flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
          <ArrowLeft className="size-4" />
          Clients
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <OrgAvatar organization={organization} size="lg" />
          <div className="min-w-0 flex-1 basis-56">
            <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-display text-[1.75rem] leading-tight font-medium sm:text-[2rem]">
              {organization.name}
              {archived && <span className="rounded-full bg-tone-neutral-soft px-2.5 py-0.5 font-sans text-xs font-medium text-tone-neutral">Archivé</span>}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {[organization.sector, organization.timezone].filter(Boolean).join(" · ")} · <span className="font-mono">/client/{organization.slug}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="lg" onClick={() => setEditing(true)}>
              <Pencil />
              Modifier
            </Button>
            {archived ? (
              <Button variant="outline" size="lg" onClick={() => archive(false)} disabled={pending}>
                <ArchiveRestore />
                Restaurer
              </Button>
            ) : (
              <Button variant="outline" size="lg" onClick={() => setArchiving(true)} disabled={pending}>
                <Archive />
                Archiver
              </Button>
            )}
          </div>
        </div>
        {archived && (
          <p className="rounded-2xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            Client archivé : ses utilisateurs n&apos;ont plus accès à leur espace. Rien n&apos;est supprimé ; « Restaurer » rétablit tout.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <Card title="Canaux" icon={Radio} count={ownChannels.length} id="canaux-title">
          <div className="overflow-hidden rounded-2xl border bg-card">
            {ownChannels.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-tone-amber">Aucun canal attribué : ce client ne voit aucune publication.</p>
            ) : (
              <ul>
                {ownChannels.map((channel) => (
                  <ChannelRow key={channel.id} channel={channel} organizations={organizations} postCount={postCount(channel)} />
                ))}
              </ul>
            )}
            {!archived && (
              <div className="grid gap-1.5 border-t bg-muted/40 px-4 py-4">
                <Label htmlFor="channel-add">Attribuer un canal libre</Label>
                {freeChannels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Tous les canaux Buffer sont déjà attribués. Pour en transférer un, utilisez la liste des canaux de la page Clients.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Select value={toAdd} onValueChange={setToAdd}>
                      <SelectTrigger id="channel-add" className="h-9! min-w-0 flex-1 basis-48 bg-card">
                        <SelectValue placeholder="Choisir un canal" />
                      </SelectTrigger>
                      <SelectContent>
                        {freeChannels.map((channel) => (
                          <SelectItem key={channel.id} value={channel.id}>
                            {channel.displayName || channel.name} — {channel.service}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="lg" onClick={addChannel} disabled={!toAdd || pending}>
                      Attribuer
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        <MembersPanel organization={organization} users={users} candidates={candidates} emails={emails} />
      </div>

      <Card title="Publications" icon={Inbox} count={ownPosts.length} id="publications-title">
        {ownPosts.length === 0 ? (
          <EmptyState icon={Inbox} title="Aucune publication" description="Les publications des canaux de ce client apparaîtront ici après une synchronisation." />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {DISPLAY_STATUSES.map((status) => {
                const total = ownPosts.filter((post) => post.status === status).length;
                return total > 0 ? (
                  <span key={status} className="flex items-center gap-1.5 text-sm">
                    <StatusBadge status={status} />
                    <span className="font-medium tabular-nums">{total}</span>
                  </span>
                ) : null;
              })}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {latest.map((post) => (
                <PostCard key={post.id} post={post} href={`/admin/publications/${post.id}`} />
              ))}
            </div>
            <Button
              variant="outline"
              size="lg"
              className="w-fit"
              onClick={() => {
                setOrgFilter(organization.id);
                router.push("/admin/publications");
              }}
            >
              Toutes les publications de ce client
              <ArrowRight />
            </Button>
          </>
        )}
      </Card>

      {editing && <ClientFormDialog organization={organization} open onOpenChange={setEditing} />}
      <ConfirmDialog open={archiving} onOpenChange={setArchiving} title={`Archiver ${organization.name} ?`} confirmLabel="Archiver le client" pending={pending} onConfirm={() => archive(true)}>
        <p>Ses utilisateurs n&apos;auront plus accès à leur espace et le client disparaîtra des listes.</p>
        <p>Rien n&apos;est supprimé : publications, commentaires, décisions et canaux sont conservés, et vous pourrez le restaurer à tout moment.</p>
      </ConfirmDialog>
    </div>
  );
}
