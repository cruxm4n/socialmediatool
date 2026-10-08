import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/shared/login-form";
import { Brand } from "@/components/shell/brand";
import { getSession, homePath } from "@/server/auth";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: PageProps<"/connexion">) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const noOrganization = params.erreur === "aucune-organisation";
  if (session && !noOrganization) redirect(homePath(session));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-10">
      <Brand href="/connexion" />
      <h1 className="mt-10 font-display text-3xl leading-tight font-medium">Connexion</h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">Accédez à vos publications et à leur validation.</p>
      {noOrganization && (
        <p role="alert" className="mb-4 rounded-lg bg-tone-amber-soft px-3 py-2 text-sm text-tone-amber">
          Votre compte n&apos;est rattaché à aucune organisation. Contactez votre agence.
        </p>
      )}
      <LoginForm />
    </main>
  );
}
