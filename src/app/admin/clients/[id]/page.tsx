import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ClientDetail } from "@/components/admin/client-detail";
import { ConnectionsPanel } from "@/components/admin/connections-panel";
import { connectionsForOrganization } from "@/lib/domain/connections";
import { isArchived } from "@/lib/domain/clients";
import { requireAdmin } from "@/server/auth";
import { listProviderConnections } from "@/server/connections";
import { credentialKeyAvailable } from "@/server/credentials";
import { env } from "@/server/env";
import { listMembers, listProfiles, listUserEmails } from "@/server/data";
import { loadWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Fiche client" };

export default async function Page({ params }: PageProps<"/admin/clients/[id]">) {
  const [session, { id }] = await Promise.all([requireAdmin(), params]);
  const organization = session.organizations.find((item) => item.id === id);
  if (!organization) notFound();

  const [workspace, profiles, members, emails, connections] = await Promise.all([loadWorkspace(), listProfiles(), listMembers(), listUserEmails(), listProviderConnections()]);
  const scoped = connections ? connectionsForOrganization(connections, organization.id) : null;
  return (
    <div className="grid grid-cols-1 gap-8">
      <ClientDetail
        organization={organization}
        organizations={session.organizations}
        channels={workspace.channels}
        posts={workspace.posts}
        profiles={profiles}
        members={members}
        emails={emails}
      />
      {scoped && (
        <section id="comptes-buffer" aria-labelledby="comptes-buffer-titre" className="grid grid-cols-1 gap-3">
          <div>
            <h2 id="comptes-buffer-titre" className="text-base font-semibold">Comptes Buffer de ce client</h2>
            <p className="text-sm text-muted-foreground">
              Paramètres propres à {organization.name}. Les canaux d&apos;un compte appartenant à ce client ne peuvent servir aucun autre client.
              {scoped.shared.length > 0 ? ` ${scoped.shared.length} compte${scoped.shared.length > 1 ? "s" : ""} partagé${scoped.shared.length > 1 ? "s" : ""} de l'agence reste${scoped.shared.length > 1 ? "nt" : ""} géré${scoped.shared.length > 1 ? "s" : ""} dans les paramètres généraux.` : ""}
            </p>
          </div>
          {isArchived(organization) ? (
            <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Client archivé : aucune connexion ne peut lui être ajoutée.</p>
          ) : (
            <ConnectionsPanel
              connections={scoped.own}
              organizations={[{ id: organization.id, name: organization.name }]}
              serverMode={env.bufferMode}
              canStoreKeys={credentialKeyAvailable()}
              organizationId={organization.id}
            />
          )}
        </section>
      )}
    </div>
  );
}
