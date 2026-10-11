import "server-only";

import type { PostVersion } from "@/lib/types";
import { createSessionClient } from "@/server/supabase/clients";

/** Historique partagé par les espaces client et administrateur, lu sous la session et les RLS. */
export async function listPostVersions(postId: string): Promise<PostVersion[]> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("post_versions").select("version, text, due_at, assets, created_at").eq("post_id", postId).order("version", { ascending: false });
  if (error && ["42P01", "PGRST205", "PGRST202", "42703"].includes(error.code ?? "")) return [];
  if (error) throw new Error(`Lecture impossible (versions) : ${error.message}`);
  return data.map((row) => ({ version: row.version, text: row.text, dueAt: row.due_at, assets: row.assets ?? [], createdAt: row.created_at }));
}
