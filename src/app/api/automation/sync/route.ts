import { hasValidAutomationSecret } from "@/server/automation-auth";
import { runSync } from "@/server/sync";

/**
 * Déclenche une synchronisation complète depuis un planificateur (cron aujourd'hui, n8n demain).
 * curl -X POST -H "x-automation-secret: …" http://127.0.0.1:3000/api/automation/sync
 */
export async function POST(request: Request) {
  if (!hasValidAutomationSecret(request)) {
    return Response.json({ ok: false, error: "Non autorisé." }, { status: 401 });
  }
  const result = await runSync("planifié");
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
