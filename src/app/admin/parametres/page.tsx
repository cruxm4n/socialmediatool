import type { Metadata } from "next";
import { Check, X } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { requireAdmin } from "@/server/auth";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Paramètres" };

/** État de la configuration serveur. Aucune valeur secrète n'est affichée, seulement sa présence. */
export default async function Page() {
  await requireAdmin();
  const rows = [
    { label: "Mode Buffer", value: env.bufferMode === "real" ? "Réel (API Buffer)" : "Simulé (aucun appel à Buffer)", ok: true, variable: "BUFFER_MODE" },
    { label: "Clé d'API Buffer", value: process.env.BUFFER_API_KEY ? "Présente, côté serveur uniquement" : "Absente", ok: Boolean(process.env.BUFFER_API_KEY) || env.bufferMode === "mock", variable: "BUFFER_API_KEY" },
    { label: "Tag de soumission au client", value: `« ${env.reviewTag} »`, ok: true, variable: "BUFFER_REVIEW_TAG" },
    { label: "Secret d'automatisation", value: process.env.AUTOMATION_SECRET ? "Présent" : "Absent", ok: Boolean(process.env.AUTOMATION_SECRET), variable: "AUTOMATION_SECRET" },
    { label: "Projet Supabase", value: new URL(env.supabaseUrl).hostname, ok: true, variable: "NEXT_PUBLIC_SUPABASE_URL" },
  ];

  return (
    <div className="grid animate-rise grid-cols-1 gap-6">
      <PageHeader title="Paramètres" description="La configuration lue par le serveur. Elle se modifie dans le fichier .env.local, puis en redémarrant l'application." />
      <ul className="overflow-hidden rounded-2xl border bg-card">
        {rows.map((row) => (
          <li key={row.variable} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-4 last:border-b-0">
            {row.ok ? <Check className="size-4 shrink-0 text-tone-green" /> : <X className="size-4 shrink-0 text-tone-red" />}
            <span className="w-56 shrink-0 text-sm font-semibold">{row.label}</span>
            <span className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">{row.value}</span>
            <code className="font-mono text-xs text-muted-foreground">{row.variable}</code>
          </li>
        ))}
      </ul>
      <p className="rounded-2xl border border-dashed p-4 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Pas encore disponible ici :</span> création de clients et d&apos;utilisateurs, changement de mot
        de passe, bascule vers n8n. Ces opérations se font pour l&apos;instant dans Supabase et dans le fichier de configuration.
      </p>
    </div>
  );
}
