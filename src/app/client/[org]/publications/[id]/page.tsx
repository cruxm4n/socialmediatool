import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReviewView } from "@/components/client/review-view";
import { requireClientSpace } from "@/server/auth";
import { loadClientSpace } from "@/server/client-space";
import { listComments, listEvents, listProfiles } from "@/server/data";

export const metadata: Metadata = { title: "Publication" };

export default async function Page({ params }: PageProps<"/client/[org]/publications/[id]">) {
  const { org, id } = await params;
  const space = await requireClientSpace(org);
  const { posts } = await loadClientSpace(space.organization);
  // Un post d'un autre client, ou non soumis, n'est pas dans cette liste : il est traité comme inexistant.
  const post = posts.find((item) => item.id === id);
  if (!post) notFound();

  const [comments, events, profiles] = await Promise.all([listComments(id), listEvents([id]), listProfiles()]);
  return <ReviewView post={post} comments={comments} events={events} profiles={profiles} basePath={`/client/${space.organization.slug}`} />;
}
