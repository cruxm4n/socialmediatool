import "server-only";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import type { Organization, Profile } from "@/lib/types";
import { createSessionClient } from "@/server/supabase/clients";

export interface Session {
  profile: Profile;
  /** Organisations visibles : toutes pour un admin (archivées comprises), les siennes pour un client. */
  organizations: Organization[];
}

/** Session de l'utilisateur connecté, ou null. Mis en cache le temps d'une requête. */
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createSessionClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;

  const [profileResult, organizationsResult] = await Promise.all([
    supabase.from("profiles").select("id, full_name, job_title, role").eq("id", data.user.id).maybeSingle(),
    // « * » : la colonne archived_at n'existe qu'après la migration 0005, l'application doit fonctionner sans.
    supabase.from("organizations").select("*").order("name"),
  ]);
  if (!profileResult.data) return null;

  return {
    profile: {
      id: profileResult.data.id,
      fullName: profileResult.data.full_name,
      jobTitle: profileResult.data.job_title,
      role: profileResult.data.role,
    },
    organizations: (organizationsResult.data ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      sector: row.sector,
      timezone: row.timezone,
      initials: row.initials,
      color: row.color,
      archivedAt: row.archived_at ?? null,
    })),
  };
});

export function homePath(session: Session): string {
  if (session.profile.role === "admin") return "/admin";
  const first = session.organizations[0];
  return first ? `/client/${first.slug}` : "/connexion?erreur=aucune-organisation";
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/connexion");
  return session;
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.profile.role !== "admin") redirect(homePath(session));
  return session;
}

/** Espace client : l'utilisateur doit être un client membre de cette organisation. */
export async function requireClientSpace(slug: string): Promise<Session & { organization: Organization }> {
  const session = await requireSession();
  if (session.profile.role !== "client") redirect(homePath(session));
  // Les règles RLS ne renvoient que ses organisations : une autre est traitée comme inexistante.
  const organization = session.organizations.find((item) => item.slug === slug);
  if (!organization) notFound();
  return { ...session, organization };
}
