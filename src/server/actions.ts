"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getSession, homePath } from "@/server/auth";
import { createSessionClient } from "@/server/supabase/clients";
import { runSync, scheduleApprovedPosts, type SyncResult } from "@/server/sync";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Messages lisibles pour les refus renvoyés par les fonctions SQL. */
const DECISION_ERRORS: Record<string, string> = {
  not_authenticated: "Votre session a expiré. Reconnectez-vous.",
  forbidden: "Seul un utilisateur client peut valider une publication.",
  not_found: "Cette publication est introuvable.",
  not_pending: "Cette publication n'attend plus de décision : un autre utilisateur a peut-être déjà répondu.",
  not_draft: "Cette publication n'est plus un brouillon dans Buffer. Elle ne peut plus être validée ici.",
  stale_version: "La publication a été modifiée depuis son affichage. Rechargez la page pour voir la dernière version.",
  comment_required: "Expliquez la modification souhaitée.",
};

function readError(message: string | undefined): string {
  const code = Object.keys(DECISION_ERRORS).find((key) => message?.includes(key));
  return code ? DECISION_ERRORS[code] : `Action impossible : ${message ?? "erreur inconnue"}`;
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
  redirect(session ? homePath(session) : "/connexion");
}

export async function signOut(): Promise<void> {
  const supabase = await createSessionClient();
  // « local » : ne ferme que cette session, pas celles ouvertes sur d'autres appareils.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/connexion");
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
  if (error) return { ok: false as const, message: readError(error.message) };
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
    if (scheduling.scheduled === 0) {
      message = "Publication approuvée. La programmation dans Buffer n'a pas abouti : votre agence est prévenue et elle sera retentée.";
    }
  } catch {
    message = "Publication approuvée. La programmation dans Buffer sera effectuée à la prochaine synchronisation.";
  }
  revalidatePath("/", "layout");
  return { ok: true, message };
}

export async function requestChanges(input: { postId: string; expectedHash: string; comment: string }): Promise<ActionResult> {
  const result = await decide("changes_requested", input);
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  return { ok: true, message: "Demande de modifications envoyée à votre agence." };
}

export async function addComment(input: { postId: string; body: string }): Promise<ActionResult> {
  const parsed = z.object({ postId: z.string().uuid(), body: z.string().trim().min(1).max(2000) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Le commentaire est vide ou trop long." };
  const supabase = await createSessionClient();
  const { error } = await supabase.rpc("add_comment", { p_post_id: parsed.data.postId, p_body: parsed.data.body });
  if (error) return { ok: false, message: readError(error.message) };
  revalidatePath("/", "layout");
  return { ok: true, message: "Commentaire ajouté." };
}

async function isAdmin(): Promise<boolean> {
  const session = await getSession();
  return session?.profile.role === "admin";
}

/** Synchronisation manuelle, réservée à l'administrateur. */
export async function syncNow(): Promise<SyncResult> {
  if (!(await isAdmin())) {
    return { ok: false, error: "Réservé à l'administrateur.", fetched: 0, created: 0, updated: 0, invalidated: 0, removed: 0, scheduled: 0, scheduleFailures: 0, unscheduled: 0 };
  }
  const result = await runSync("manuel");
  revalidatePath("/", "layout");
  return result;
}

/** Rattache un canal Buffer à un client. La base refuse l'opération à tout autre qu'un admin. */
export async function assignChannel(input: { channelId: string; organizationId: string | null }): Promise<ActionResult> {
  const parsed = z.object({ channelId: z.string().uuid(), organizationId: z.string().uuid().nullable() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Demande invalide." };
  if (!(await isAdmin())) return { ok: false, message: "Réservé à l'administrateur." };

  const supabase = await createSessionClient();
  const { data, error } = await supabase
    .from("channels")
    .update({ organization_id: parsed.data.organizationId })
    .eq("id", parsed.data.channelId)
    .select("id");
  if (error || !data?.length) return { ok: false, message: `Rattachement impossible : ${error?.message ?? "canal introuvable"}` };
  revalidatePath("/", "layout");
  return { ok: true, message: parsed.data.organizationId ? "Canal rattaché au client." : "Canal détaché." };
}
