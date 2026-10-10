import { hasValidAutomationSecret } from "@/server/automation-auth";
import { runUrgent } from "@/server/urgent";

/**
 * Traitement urgent à la demande (surveillance externe, reprise après incident). Ne lit pas Buffer s'il n'y a rien à
 * faire. 200 : rien à faire ou tout terminé ; 502 : une annulation ou un rapprochement n'a pas abouti (l'urgence
 * reste enregistrée et visible, la reprise continue).
 * curl -X POST -H "x-automation-secret: …" http://127.0.0.1:3000/api/automation/urgent
 */
export async function POST(request: Request) {
  if (!hasValidAutomationSecret(request)) {
    return Response.json({ ok: false, error: "Non autorisé." }, { status: 401 });
  }
  const { rateLimited, ...result } = await runUrgent();
  return Response.json({ ...result, rateLimited: rateLimited !== null }, { status: result.ok ? 200 : 502 });
}
