import "server-only";

import { StudioEditor } from "@/components/studio/studio-editor";
import type { Organization, StudioDraft } from "@/lib/types";
import { listMedia } from "@/server/studio";
import { loadWorkspace } from "@/server/workspace";

/** Charge ce dont l'éditeur a besoin pour un client : ses canaux, sa bibliothèque, son calendrier. */
export async function renderStudioEditor(organization: Organization, draft: StudioDraft | null) {
  const [workspace, media] = await Promise.all([loadWorkspace(), listMedia(organization.id, draft?.mediaIds ?? [])]);
  return (
    <StudioEditor
      // Clé stable : un rafraîchissement de la page (après un envoi, par exemple) met les données à jour
      // sans remonter l'éditeur, qui garderait sinon l'état de la base et perdrait la saisie en cours.
      key={draft?.id ?? `nouveau-${organization.id}`}
      draft={draft}
      organization={organization}
      channels={workspace.channels.filter((channel) => channel.organizationId === organization.id)}
      media={media ?? []}
      scheduled={workspace.posts
        .filter((post) => post.status !== "published" && post.organization?.id === organization.id)
        .map((post) => ({ id: post.bufferPostId, channelId: post.channelId, dueAt: post.dueAt, title: post.title }))}
      now={workspace.now}
    />
  );
}
