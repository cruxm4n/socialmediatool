import { hasValidAutomationSecret } from "@/server/automation-auth";
import { runSync } from "@/server/sync";

/**
 * Déclenche une synchronisation complète depuis un planificateur (tâche planifiée ou n8n).
 * curl -X POST -H "x-automation-secret: …" http://127.0.0.1:3000/api/automation/sync
 *
 * 401 : secret absent ou faux. 200 : tout a réussi, ou rien n'était à faire (« skipped » : une autre
 * synchronisation est en cours, ou les exécutions planifiées sont en pause). 502 : échec total ou partiel.
 */
export async function POST(request: Request) {
  if (!hasValidAutomationSecret(request)) {
    return Response.json({ ok: false, error: "Non autorisé." }, { status: 401 });
  }
  const result = await runSync("planifié", { scheduled: true });
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
