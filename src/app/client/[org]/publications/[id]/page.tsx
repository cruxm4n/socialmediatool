import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReviewView } from "@/components/client/review-view";
import { canDecide } from "@/lib/domain/status";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";
import { listComments, listEvents, listProfiles } from "@/server/data";
import { listPostVersions } from "@/server/studio";

export const metadata: Metadata = { title: "Publication" };

export default async function Page({ params }: PageProps<"/client/[org]/publications/[id]">) {
  const { org, id } = await params;
  const space = await requireClientSpace(org);
  const { posts, now } = await loadClientSpace(space.organization);
  // Un post d'un autre client, ou non soumis, n'est pas dans cette liste : il est traité comme inexistant.
  const post = posts.find((item) => item.id === id);
  if (!post) notFound();

  const [comments, events, profiles, versions] = await Promise.all([listComments(id), listEvents({ postId: id }), listProfiles(), listPostVersions(id)]);
  const nextPending = posts.find((item) => item.id !== id && canDecide(item));

  return (
    <ReviewView
      post={post}
      comments={comments}
      events={events}
      profiles={profiles}
      basePath={`/client/${space.organization.slug}`}
      now={now}
      nextPendingId={nextPending?.id ?? null}
      versions={versions}
    />
  );
}
