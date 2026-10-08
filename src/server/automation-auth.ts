import "server-only";

import { timingSafeEqual } from "node:crypto";

import { env } from "@/server/env";

/** Vérifie l'en-tête x-automation-secret des appels de serveur à serveur (cron, plus tard n8n). */
export function hasValidAutomationSecret(request: Request): boolean {
  const provided = Buffer.from(request.headers.get("x-automation-secret") ?? "");
  const expected = Buffer.from(env.automationSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
