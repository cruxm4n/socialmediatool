// Processus de test qui S'ARRÊTE BRUTALEMENT (SIGKILL) juste après un effet externe, avant toute confirmation locale :
// c'est la fenêtre de crash de la mission V3 (C02/C03). Écrit en JavaScript simple : il ne charge aucun code de
// l'application, seulement l'API HTTP de la pile de test et le faux Buffer persistant (fichier JSON).
//
//   node crash-worker.mjs '{"action":"schedule-then-die", ...}'
import { readFileSync, writeFileSync } from "node:fs";

const args = JSON.parse(process.argv[2]);
const headers = (token) => ({ apikey: args.anon, Authorization: `Bearer ${token ?? args.anon}`, "Content-Type": "application/json" });
const rpc = async (name, body, token) => {
  const response = await fetch(`${args.url}/rest/v1/rpc/${name}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${name} : HTTP ${response.status} ${await response.text()}`);
  return response.json();
};
const state = () => JSON.parse(readFileSync(args.file, "utf8"));
const save = (value) => writeFileSync(args.file, JSON.stringify(value));
const die = () => process.kill(process.pid, "SIGKILL");

if (args.action === "schedule-then-die") {
  // Réserve la programmation (intention durable en base), Buffer l'accepte (effet), puis le processus s'arrête.
  const claimed = await rpc("claim_posts_for_scheduling_in_mode", { p_secret: args.secret, p_mode: "mock", p_post_id: args.postId });
  if (!claimed.length) throw new Error("aucune réservation obtenue");
  const value = state();
  value.calls.schedulePost = (value.calls.schedulePost ?? 0) + 1;
  value.posts[args.bufferPostId].status = "scheduled";
  save(value);
  die();
} else if (args.action === "studio-create-then-die") {
  const login = await fetch(`${args.url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: args.anon, "Content-Type": "application/json" }, body: JSON.stringify({ email: args.email, password: args.password }),
  });
  const { access_token: token } = await login.json();
  const claimed = await rpc("studio_claim_push", { p_draft_id: args.draftId, p_force: false }, token);
  if (!claimed.length) throw new Error("aucune réservation Studio obtenue");
  const value = state();
  value.seq += 1;
  const row = claimed[0];
  const id = `mock-${args.run}-crash-${value.seq}`;
  value.posts[id] = {
    id, channelId: row.buffer_channel_id, service: row.service, status: "draft", text: row.text, dueAt: row.due_at,
    sentAt: null, updatedAt: null, externalLink: null, error: null, hasReviewTag: true, schedulingType: "automatic", assets: [],
  };
  value.calls.createDraft = (value.calls.createDraft ?? 0) + 1;
  save(value);
  die();
} else {
  throw new Error(`action inconnue : ${args.action}`);
}
