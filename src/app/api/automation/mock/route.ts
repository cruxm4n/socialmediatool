import { hasValidAutomationSecret } from "@/server/automation-auth";
import { env, simulatedBufferAllowed } from "@/server/env";
import { MockProvider } from "@/server/publishing/mock-provider";

/**
 * Leviers de test du Buffer simulé (modifier un texte, simuler un échec, rendre un compte injoignable…).
 * Inexistant hors du mode simulé — donc inexistant en production, où la simulation exige une autorisation explicite.
 * `account` : compte simulé d'une connexion (son « account_key ») ; absent : le compte de démonstration.
 */
export async function POST(request: Request) {
  if (env.bufferMode !== "mock" || !simulatedBufferAllowed()) return new Response("Not found", { status: 404 });
  if (!hasValidAutomationSecret(request)) return Response.json({ ok: false }, { status: 401 });

  const body = (await request.json()) as { action: string; key?: string; text?: string; status?: string; message?: string; tagged?: boolean; service?: string; name?: string; account?: string; unavailable?: boolean };
  if (body.account !== undefined && !/^[a-z0-9]{1,24}$/.test(body.account)) return Response.json({ ok: false, error: "Compte invalide." }, { status: 400 });
  const provider = new MockProvider(env.mockRunId, body.account);
  const id = `mock-${env.mockRunId}-${body.account ? `${body.account}-` : ""}${body.key}`;

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
    case "addChannel":
      provider.addChannel(body.key ?? "libre", body.service ?? "linkedin", body.name ?? "Canal libre");
      break;
    case "setUnavailable":
      provider.setUnavailable(Boolean(body.unavailable));
      break;
    case "stats": {
      // Lecture directe de l'état simulé (un compte « injoignable » reste observable par le test).
      const snapshot = await provider.fetchSnapshot().catch(() => null);
      return Response.json({ ok: true, scheduleCalls: provider.scheduleCalls, createCalls: provider.createCalls, post: snapshot?.posts.find((post) => post.id === id) ?? null, posts: snapshot?.posts.map((post) => ({ id: post.id, status: post.status })) ?? null });
    }
    default:
      return Response.json({ ok: false, error: "Action inconnue." }, { status: 400 });
  }
  return Response.json({ ok: true });
}
