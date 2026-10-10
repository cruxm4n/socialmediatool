import { hasValidAutomationSecret } from "@/server/automation-auth";
import { readiness } from "@/server/readiness";

/**
 * Préparation au service (≠ /api/health, qui dit seulement que le processus tourne). Protégée par le secret
 * d'automatisation : un visiteur n'apprend rien de la configuration ni du schéma. 200 : prête ; 503 : à ne pas
 * mettre en service, avec la liste des contrôles en échec (noms seulement).
 *   curl -H "x-automation-secret: …" http://127.0.0.1:3000/api/ready
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Secret d'automatisation non configuré : aucune authentification n'est possible, l'application n'est de toute façon
  // pas prête. On renvoie 503 avec les NOMS des contrôles en échec (jamais de valeur).
  if (!process.env.AUTOMATION_SECRET) {
    const result = await readiness();
    return Response.json(result, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!hasValidAutomationSecret(request)) {
    return Response.json({ ok: false, error: "Non autorisé." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const result = await readiness();
  return Response.json(result, { status: result.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
