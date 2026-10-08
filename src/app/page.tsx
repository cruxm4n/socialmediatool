import { redirect } from "next/navigation";

import { getSession, homePath } from "@/server/auth";

/** Aiguille l'utilisateur vers son espace selon son rôle. */
export default async function HomePage() {
  const session = await getSession();
  redirect(session ? homePath(session) : "/connexion");
}
