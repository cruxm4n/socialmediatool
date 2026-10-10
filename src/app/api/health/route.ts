/**
 * Santé de l'application, pour le HEALTHCHECK Docker. Répond sans appeler Supabase ni Buffer :
 * elle dit seulement que le serveur Next.js tourne. L'état de la synchronisation se lit dans Administration.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, version: process.env.CADENCE_VERSION ?? "inconnu" }, { headers: { "Cache-Control": "no-store" } });
}
