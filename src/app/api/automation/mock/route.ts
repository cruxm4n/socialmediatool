import { hasValidAutomationSecret } from "@/server/automation-auth";
import { env } from "@/server/env";
import { MockProvider } from "@/server/publishing/mock-provider";

/**
 * Leviers de test du Buffer simulé (modifier un texte, simuler un échec…).
 * Inexistant hors du mode simulé.
 */
export async function POST(request: Request) {
  if (env.bufferMode !== "mock") return new Response("Not found", { status: 404 });
  if (!hasValidAutomationSecret(request)) return Response.json({ ok: false }, { status: 401 });

  const body = (await request.json()) as { action: string; key?: string; text?: string; status?: string; message?: string; tagged?: boolean };
  const provider = new MockProvider(env.mockRunId);
  const id = `mock-${env.mockRunId}-${body.key}`;

  switch (body.action) {
    case "editText":
      provider.editText(id, body.text ?? "");
      break;
    case "setStatus":
      provider.setStatus(id, body.status as never);
      break;
    case "setReviewTag":
      provider.setReviewTag(id, Boolean(body.tagged));
      break;
    case "remove":
      provider.remove(id);
      break;
    case "failNextSchedule":
      provider.failNextSchedule(body.message ?? "Échec simulé.");
      break;
    case "stats":
      return Response.json({ ok: true, scheduleCalls: provider.scheduleCalls, post: await provider.getPost(id) });
    default:
      return Response.json({ ok: false, error: "Action inconnue." }, { status: 400 });
  }
  return Response.json({ ok: true });
}
