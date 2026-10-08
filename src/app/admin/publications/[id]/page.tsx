import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PostDetail } from "@/components/publications/post-detail";
import { buildPostViews } from "@/lib/view";
import { requireAdmin } from "@/server/auth";
import { getPost, listChannels, listComments, listEvents, listProfiles } from "@/server/data";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Publication" };

export default async function Page({ params }: PageProps<"/admin/publications/[id]">) {
  const [session, { id }] = await Promise.all([requireAdmin(), params]);
  const post = await getPost(id);
  if (!post) notFound();

  const [channels, comments, events, profiles] = await Promise.all([listChannels(), listComments(id), listEvents({ postId: id }), listProfiles()]);
  const [view] = buildPostViews([post], channels, session.organizations);

  return <PostDetail post={view} comments={comments} events={events} profiles={profiles} now={new Date().toISOString()} reviewTag={env.reviewTag} />;
}
