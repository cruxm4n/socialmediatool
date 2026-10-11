import { redirect } from "next/navigation";

import { requireAdmin } from "@/server/auth";

/** Compatibilité des favoris : la création et l’édition se font désormais dans Buffer. */
export default async function Page() {
  await requireAdmin();
  redirect("/admin/publications");
}
