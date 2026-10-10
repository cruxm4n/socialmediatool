"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { z } from "zod";

import type { ActionResult } from "@/lib/action-result";
import { ADMIN_ERRORS, initialsFor, slugify } from "@/lib/domain/clients";
import { errorCodeIn } from "@/lib/domain/errors";
import { getSession, homePath } from "@/server/auth";
import { dispatchNotifications } from "@/server/notifications";
import { createSessionClient } from "@/server/supabase/clients";
import { runSync, scheduleApprovedPosts, type SyncResult } from "@/server/sync";

const SESSION_EXPIRED: ActionResult = { ok: false, message: "Votre session a expiré. Reconnectez-vous.", expired: true };

/** Messages lisibles pour les refus renvoyés par les fonctions SQL. */
const DECISION_ERRORS: Record<string, string> = {
  not_authenticated: "Votre session a expiré. Reconnectez-vous.",
  forbidden: "Seul un utilisateur client peut valider une publication.",
  not_found: "Cette publication est introuvable.",
  not_pending: "Cette publication n'attend plus de décision : un autre utilisateur a peut-être déjà répondu.",
  not_draft: "Cette publication n'est plus un brouillon dans Buffer. Elle ne peut plus être validée ici.",
  stale_version: "La publication a été modifiée depuis son affichage. Rechargez la page pour voir la dernière version.",
  comment_required: "Expliquez la modification souhaitée.",
  date_invalid: "La date prévue de cette publication est absente ou dépassée. Demandez à votre agence de la corriger avant de l'approuver.",
  date_too_close: "La date prévue est trop proche pour être programmée (moins de 10 minutes). Demandez à votre agence de la repousser avant de l'approuver.",
  invalid_decision: "Demande invalide.",
};

function toFailure(message: string | undefined): ActionResult {
  // Sans session, la base refuse soit par la fonction elle-même, soit avant même de l'exécuter.
  if (message?.includes("not_authenticated") || message?.includes("permission denied for function")) return SESSION_EXPIRED;
  const code = errorCodeIn(message, Object.keys(DECISION_ERRORS));
  return { ok: false, message: code ? DECISION_ERRORS[code] : `Action impossible : ${message ?? "erreur inconnue"}` };
}

const credentialsSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function signIn(_previous: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { ok: false, message: "Saisissez votre adresse e-mail et votre mot de passe." };

  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { ok: false, message: "Adresse e-mail ou mot de passe incorrect." };

  const session = await getSession();
  if (!session) {
    // Identifiants corrects mais aucun profil dans l'application : on ne laisse pas une session inutilisable ouverte.
    await supabase.auth.signOut({ scope: "local" });
    return { ok: false, message: "Ce compte n'est pas encore configuré. Contactez votre agence." };
  }
  redirect(homePath(session));
}

export async function signOut(): Promise<void> {
  const supabase = await createSessionClient();
  // « local » : ne ferme que cette session, pas celles ouvertes sur d'autres appareils.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/connexion");
}

/** Remet les notifications nées de l'action, une fois la réponse envoyée : l'utilisateur n'attend pas. */
function notifySoon(): void {
  try {
    after(() => dispatchNotifications().catch(() => undefined));
  } catch {
    // Hors d'une requête (tests) : la remise aura lieu à la synchronisation suivante.
  }
}

/**
 * Une action d'administration peut avoir placé des programmations en « annulation à confirmer » (transfert,
 * archivage, retrait d'un membre) : la compensation part tout de suite, une fois la réponse envoyée.
 */
function compensateSoon(): void {
  try {
    after(async () => {
      try {
        const { compensatePendingUnschedules } = await import("@/server/sync");
        await compensatePendingUnschedules();
      } catch {
        // La reprise de chaque synchronisation s'en charge.
      }
    });
  } catch {
    // Hors d'une requête (tests) : la synchronisation suivante compense.
  }
}

const decisionSchema = z.object({
  postId: z.string().uuid(),
  expectedHash: z.string().min(1),
  comment: z.string().max(2000).optional(),
});

async function decide(decision: "approved" | "changes_requested", input: unknown) {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, message: "Demande invalide." };
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("decide_post", {
    p_post_id: parsed.data.postId,
    p_decision: decision,
    p_expected_hash: parsed.data.expectedHash,
    p_comment: parsed.data.comment ?? null,
  });
  if (error) return { ...toFailure(error.message), ok: false as const };
  return { ok: true as const, postId: parsed.data.postId };
}

/**
 * Approbation par le client, puis programmation immédiate dans Buffer.
 * Les droits sont vérifiés par la fonction SQL decide_post, pas ici.
 */
export async function approvePost(input: { postId: string; expectedHash: string }): Promise<ActionResult> {
  const result = await decide("approved", input);
  if (!result.ok) return result;

  let message = "Publication approuvée et programmée dans Buffer.";
  try {
    const scheduling = await scheduleApprovedPosts(result.postId);
    if (scheduling.writesDisabled) {
      message = "Publication approuvée. La programmation dans Buffer n'est pas encore activée par votre agence : elle sera faite dès son activation.";
    } else if (scheduling.paused) {
      message = "Publication approuvée. Le quota de requêtes Buffer est atteint : la programmation reprendra d'elle-même à la fin de la pause.";
    } else if (scheduling.scheduled === 0) {
      message = "Publication approuvée. La programmation dans Buffer n'a pas abouti : votre agence est prévenue et elle sera retentée.";
    }
  } catch {
    message = "Publication approuvée. La programmation dans Buffer sera effectuée à la prochaine synchronisation.";
  }
  notifySoon();
  revalidatePath("/", "layout");
  return { ok: true, message };
}

/**
 * Approbation groupée : chaque publication est décidée séparément par la base, avec les mêmes
 * contrôles que l'approbation à l'unité (droits, version affichée, date). Un refus n'empêche pas les autres.
 */
export async function approvePosts(items: { postId: string; expectedHash: string }[]): Promise<ActionResult & { approved: number; refused: { postId: string; message: string }[] }> {
  const parsed = z.array(decisionSchema).min(1).max(50).safeParse(items);
  if (!parsed.success) return { ok: false, message: "Sélection invalide.", approved: 0, refused: [] };

  let approved = 0;
  const refused: { postId: string; message: string }[] = [];
  for (const item of parsed.data) {
    const result = await decide("approved", item);
    if (result.ok) approved += 1;
    else if ("expired" in result && result.expired) return { ...SESSION_EXPIRED, approved, refused };
    else refused.push({ postId: item.postId, message: result.message });
  }
  if (approved > 0) {
    // Programmation de tout ce qui vient d'être approuvé ; en cas de panne, la synchronisation suivante s'en charge.
    await scheduleApprovedPosts().catch(() => undefined);
    notifySoon();
    revalidatePath("/", "layout");
  }
  const s = approved > 1 ? "s" : "";
  return {
    ok: approved > 0,
    approved,
    refused,
    message:
      refused.length === 0
        ? `${approved} publication${s} approuvée${s}.`
        : `${approved} publication${s} approuvée${s}, ${refused.length} refusée${refused.length > 1 ? "s" : ""} : ${refused[0].message}`,
  };
}

export async function requestChanges(input: { postId: string; expectedHash: string; comment: string }): Promise<ActionResult> {
  const result = await decide("changes_requested", input);
  if (!result.ok) return result;
  notifySoon();
  revalidatePath("/", "layout");
  return { ok: true, message: "Demande de modifications envoyée à votre agence." };
}

export async function addComment(input: { postId: string; body: string }): Promise<ActionResult> {
  const parsed = z.object({ postId: z.string().uuid(), body: z.string().trim().min(1).max(2000) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Le commentaire est vide ou trop long." };
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("add_comment", { p_post_id: parsed.data.postId, p_body: parsed.data.body });
  if (error) return toFailure(error.message);
  revalidatePath("/", "layout");
  return { ok: true, message: "Commentaire ajouté." };
}

/** null : accès autorisé. Sinon, le refus à renvoyer. */
async function adminRefusal(): Promise<ActionResult | null> {
  const session = await getSession();
  if (!session) return SESSION_EXPIRED;
  return session.profile.role === "admin" ? null : { ok: false, message: "Réservé à l'administrateur." };
}

/** Synchronisation manuelle, réservée à l'administrateur. */
export async function syncNow(): Promise<SyncResult & { expired?: boolean }> {
  const refusal = await adminRefusal();
  if (refusal) {
    return { ok: false, error: refusal.message, expired: refusal.expired, fetched: 0, created: 0, updated: 0, invalidated: 0, removed: 0, scheduled: 0, scheduleFailures: 0, unscheduled: 0, unscheduleFailures: 0 };
  }
  const result = await runSync("manuel");
  revalidatePath("/", "layout");
  return result;
}

const MIGRATION_REQUIRED = "Cette action demande la migration 0005 de la base (voir TESTING.md).";

/** Appelle une fonction SQL d'administration et traduit ses refus. Les droits sont vérifiés par la base. */
async function adminRpc<T = unknown>(name: string, params: Record<string, unknown>): Promise<{ data: T; failure: null } | { data: null; failure: ActionResult & { code?: string } }> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.rpc(name, params);
  if (!error) return { data: data as T, failure: null };
  if (error.code === "PGRST202") return { data: null, failure: { ok: false, message: MIGRATION_REQUIRED, code: "migration_required" } };
  if (error.message.includes("not_authenticated") || error.message.includes("permission denied for function")) return { data: null, failure: SESSION_EXPIRED };
  const code = errorCodeIn(error.message, [...Object.keys(ADMIN_ERRORS), "transfer_confirmation_required"]);
  return { data: null, failure: { ok: false, code, message: code && ADMIN_ERRORS[code] ? ADMIN_ERRORS[code] : `Action impossible : ${error.message}` } };
}

const organizationSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  sector: z.string().trim().max(80),
  timezone: z.string().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

/** Crée ou modifie un client. L'adresse de son espace est déduite du nom à la création, puis ne change plus. */
export async function saveOrganization(input: { id?: string; name: string; sector: string; timezone: string; color: string }): Promise<ActionResult & { id?: string }> {
  const parsed = organizationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: ADMIN_ERRORS.invalid_name };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  const { id, name, sector, timezone, color } = parsed.data;
  const result = await adminRpc<string>("admin_save_organization", {
    p_id: id ?? null, p_name: name, p_slug: slugify(name), p_sector: sector, p_timezone: timezone, p_initials: initialsFor(name), p_color: color,
  });
  if (result.failure) return result.failure;
  revalidatePath("/", "layout");
  return { ok: true, message: id ? "Client modifié." : "Client créé.", id: result.data };
}

export async function setOrganizationArchived(input: { id: string; archived: boolean }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid(), archived: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  const result = await adminRpc("admin_set_organization_archived", { p_id: parsed.data.id, p_archived: parsed.data.archived });
  if (result.failure) return result.failure;
  compensateSoon();
  revalidatePath("/", "layout");
  return { ok: true, message: parsed.data.archived ? "Client archivé : ses membres n'ont plus accès." : "Client restauré." };
}

/**
 * Rattache, détache ou transfère un canal Buffer. Seule l'attribution dans Cadence change : rien n'est modifié dans Buffer.
 * Un transfert vers un autre client (canal portant déjà des publications) renvoie `needsConfirmation` tant qu'il n'est pas confirmé.
 */
export async function assignChannel(input: { channelId: string; organizationId: string | null; confirmTransfer?: boolean }): Promise<ActionResult & { needsConfirmation?: boolean }> {
  const parsed = z.object({ channelId: z.string().uuid(), organizationId: z.string().uuid().nullable(), confirmTransfer: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  const { channelId, organizationId, confirmTransfer } = parsed.data;

  const result = await adminRpc<{ transferred: boolean; hidden_posts: number; suspended_posts?: number }>("admin_assign_channel", {
    p_channel_id: channelId, p_organization_id: organizationId, p_confirm_transfer: confirmTransfer ?? false,
  });
  if (result.failure?.code === "transfer_confirmation_required") {
    return { ok: false, needsConfirmation: true, message: "Ce canal a déjà appartenu à un autre client : confirmez le transfert." };
  }
  if (result.failure?.code === "migration_required") return assignChannelLegacy(channelId, organizationId);
  if (result.failure) return result.failure;
  compensateSoon();
  revalidatePath("/", "layout");
  const suspended = result.data.suspended_posts ?? 0;
  const suspension = suspended > 0
    ? ` ${suspended} publication${suspended > 1 ? "s" : ""} non publiée${suspended > 1 ? "s" : ""} suspendue${suspended > 1 ? "s" : ""} (validation retirée) ; l'annulation des programmations déjà acceptées par Buffer est lancée tout de suite et sera confirmée dans le suivi (reprise à chaque synchronisation si elle échoue).`
    : "";
  if (!organizationId) return { ok: true, message: `Canal détaché.${suspension}` };
  return {
    ok: true,
    message: (result.data.transferred
      ? `Canal transféré. ${result.data.hidden_posts} publication${result.data.hidden_posts > 1 ? "s" : ""} antérieure${result.data.hidden_posts > 1 ? "s" : ""} reste${result.data.hidden_posts > 1 ? "nt" : ""} invisible${result.data.hidden_posts > 1 ? "s" : ""} pour le nouveau client ; les nouvelles importations restent réservées à l'administrateur jusqu'à attribution.`
      : "Canal rattaché au client.") + suspension,
  };
}

/**
 * Base sans la migration 0005 (schéma sans garanties d'appartenance). Seule opération sûre : rattacher à
 * un client un canal libre qui ne porte AUCUNE publication. Tout le reste est refusé :
 * - un transfert direct montrerait au nouveau client l'historique de l'ancien ;
 * - « détacher puis rattacher » à un autre client produirait le même effet (le canal détaché paraît libre
 *   alors que son historique existe) ; ce schéma ne conserve pas l'ancien propriétaire pour le détecter.
 */
async function assignChannelLegacy(channelId: string, organizationId: string | null): Promise<ActionResult> {
  const refused = `Attribution impossible pour l'instant : cette base n'a pas les garanties d'isolation de l'historique. ${MIGRATION_REQUIRED}`;
  if (!organizationId) return { ok: false, message: refused };
  const supabase = await createSessionClient();
  const current = await supabase.from("channels").select("organization_id").eq("id", channelId).maybeSingle();
  if (current.error || !current.data) return { ok: false, message: "Rattachement impossible : canal introuvable." };
  if (current.data.organization_id) return { ok: false, message: refused };
  const history = await supabase.from("posts").select("id", { count: "exact", head: true }).eq("channel_id", channelId);
  if (history.error) return { ok: false, message: `Rattachement impossible : ${history.error.message}` };
  // Historique illisible ou non vide : on ne suppose jamais le canal vide.
  if (typeof history.count !== "number" || !Number.isFinite(history.count) || history.count > 0) return { ok: false, message: refused };
  const { data, error } = await supabase.from("channels").update({ organization_id: organizationId }).eq("id", channelId).select("id");
  if (error || !data?.length) return { ok: false, message: `Rattachement impossible : ${error?.message ?? "canal introuvable"}` };
  revalidatePath("/", "layout");
  return { ok: true, message: "Canal rattaché au client." };
}

/**
 * Attribue des publications importées de façon ambiguë (canal transféré ou détaché) à un client.
 * Tant que ce n'est pas fait, elles restent visibles de l'administrateur seul.
 */
export async function setPostOwner(input: { postIds: string[]; organizationId: string }): Promise<ActionResult & { assigned?: number }> {
  const parsed = z.object({ postIds: z.array(z.string().uuid()).min(1).max(200), organizationId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  const result = await adminRpc<number>("admin_set_post_owner", { p_post_ids: parsed.data.postIds, p_organization_id: parsed.data.organizationId });
  if (result.failure) return result.failure;
  revalidatePath("/", "layout");
  const n = result.data ?? 0;
  return { ok: true, assigned: n, message: n === 0 ? "Aucune publication à attribuer." : `${n} publication${n > 1 ? "s" : ""} attribuée${n > 1 ? "s" : ""}.` };
}

/** Associe ou dissocie un utilisateur client déjà connu et un client. */
export async function setMember(input: { organizationId: string; userId: string; member: boolean }): Promise<ActionResult> {
  const parsed = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid(), member: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  const result = await adminRpc("admin_set_member", { p_organization_id: parsed.data.organizationId, p_user_id: parsed.data.userId, p_member: parsed.data.member });
  if (result.failure) return result.failure;
  if (!parsed.data.member) compensateSoon();
  revalidatePath("/", "layout");
  return { ok: true, message: parsed.data.member ? "Accès accordé." : "Accès retiré." };
}

/** Donne accès à un compte créé (ou invité) dans Supabase, retrouvé par son e-mail. */
export async function addUserByEmail(input: { organizationId: string; email: string; fullName: string; jobTitle: string }): Promise<ActionResult> {
  const parsed = z
    .object({ organizationId: z.string().uuid(), email: z.string().trim().email(), fullName: z.string().trim().max(80), jobTitle: z.string().trim().max(80) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: "Saisissez une adresse e-mail valide." };
  const refusal = await adminRefusal();
  if (refusal) return refusal;
  const result = await adminRpc("admin_add_user", {
    p_organization_id: parsed.data.organizationId, p_email: parsed.data.email, p_full_name: parsed.data.fullName, p_job_title: parsed.data.jobTitle,
  });
  if (result.failure) {
    return result.failure.code === "invalid_name" ? { ok: false, message: "Première association de ce compte : indiquez son nom." } : result.failure;
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Accès accordé." };
}

const preferencesSchema = z.object({
  review_requested: z.boolean().optional(),
  changes_requested: z.boolean().optional(),
  approved: z.boolean().optional(),
  schedule_error: z.boolean().optional(),
});

/** Chacun règle ses propres notifications ; la base n'accepte que l'utilisateur connecté. */
export async function saveNotificationPreferences(input: Partial<Record<"review_requested" | "changes_requested" | "approved" | "schedule_error", boolean>>): Promise<ActionResult> {
  const parsed = preferencesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  if (!(await getSession())) return SESSION_EXPIRED;
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("set_notification_preferences", {
    p_review_requested: parsed.data.review_requested ?? null,
    p_changes_requested: parsed.data.changes_requested ?? null,
    p_approved: parsed.data.approved ?? null,
    p_schedule_error: parsed.data.schedule_error ?? null,
  });
  if (error?.code === "PGRST202") return { ok: false, message: "Les notifications demandent la migration 0007 de la base." };
  if (error) return toFailure(error.message);
  revalidatePath("/", "layout");
  return { ok: true, message: "Préférences enregistrées." };
}
