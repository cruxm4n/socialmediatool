#!/usr/bin/env node
// Passerelle HTTP minimale pour une pile Supabase locale isolée : reproduit les chemins du gateway Supabase
// (/auth/v1, /rest/v1, /storage/v1) vers les services, sans Kong. Écoute sur 127.0.0.1 par défaut.
//   node scripts/lib/gateway.mjs --listen 55600 --auth 55601 --rest 55602 --storage 55603 [--bind 172.29.0.1]
// --bind : adresse d'écoute (défaut 127.0.0.1) ; --auth-host/--rest-host/--storage-host : hôte des services (défaut
// 127.0.0.1). Dans un conteneur relié au réseau de la pile (scripts/image-journey.mjs), --bind 0.0.0.0 ne vaut que
// DANS le réseau Docker dédié : aucun port n'est publié.
import { createServer, request } from "node:http";

const args = process.argv.slice(2);
const port = (name) => Number(args[args.indexOf(`--${name}`) + 1]);
const host = (name) => (args.includes(`--${name}-host`) ? args[args.indexOf(`--${name}-host`) + 1] : "127.0.0.1");
// Chaque route : préfixe, port, hôte du service (127.0.0.1 par défaut ; un nom de conteneur quand la passerelle
// tourne dans un conteneur relié au réseau de la pile).
const routes = [
  ["/auth/v1", port("auth"), host("auth")],
  ["/rest/v1", port("rest"), host("rest")],
  ["/storage/v1", port("storage"), host("storage")],
];
for (const [, target] of routes) if (!Number.isInteger(target) || target <= 0) throw new Error("ports invalides");

/** Kong ajoute les en-têtes CORS dans la pile Supabase ; ici, seulement pour des origines locales (boucle locale). */
const localOrigin = (origin) => typeof origin === "string" && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
const corsHeaders = (incoming) =>
  localOrigin(incoming.headers.origin)
    ? {
        "access-control-allow-origin": incoming.headers.origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": incoming.headers["access-control-request-headers"] ?? "authorization, apikey, content-type, x-client-info, x-upsert, cache-control",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
        "access-control-expose-headers": "content-range, x-total-count, content-length",
        vary: "origin",
      }
    : {};

createServer((incoming, outgoing) => {
  if (incoming.method === "OPTIONS") {
    outgoing.writeHead(204, { ...corsHeaders(incoming), "access-control-max-age": "600" }).end();
    return;
  }
  const route = routes.find(([prefix]) => incoming.url === prefix || incoming.url.startsWith(`${prefix}/`) || incoming.url.startsWith(`${prefix}?`));
  if (!route) {
    outgoing.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "route inconnue" }));
    return;
  }
  const [prefix, target, upstreamHost] = route;
  const upstream = request(
    { host: upstreamHost, port: target, method: incoming.method, path: incoming.url.slice(prefix.length) || "/", headers: { ...incoming.headers, host: `${upstreamHost}:${target}` } },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, { ...response.headers, ...corsHeaders(incoming) });
      response.pipe(outgoing);
    },
  );
  upstream.on("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ message: `service indisponible : ${error.message}` }));
  });
  incoming.pipe(upstream);
}).listen(port("listen"), args.includes("--bind") ? args[args.indexOf("--bind") + 1] : "127.0.0.1");
