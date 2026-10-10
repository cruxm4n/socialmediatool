import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import WebSocket from "ws";

import { isHttps, withSecure } from "@/lib/secure-cookies";
import { env } from "@/server/env";

// supabase-js exige un WebSocket même si le temps réel n'est pas utilisé ; Node 20 n'en fournit pas.
const realtime = { transport: WebSocket as unknown as typeof globalThis.WebSocket };

/**
 * Client lié à la session de l'utilisateur : toutes les lectures passent par les règles RLS.
 * Créé une seule fois par requête.
 */
export const createSessionClient = cache(async (): Promise<SupabaseClient> => {
  const cookieStore = await cookies();
  const secure = isHttps((await headers()).get("x-forwarded-proto"));
  return createServerClient(env.supabaseUrl, env.supabaseKey, {
    realtime,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        try {
          for (const { name, value, options } of items) cookieStore.set(name, value, withSecure(options, secure));
        } catch {
          // Appelé depuis un composant serveur : l'écriture de cookies y est impossible.
          // La session est rafraîchie par src/proxy.ts.
        }
      },
    },
  });
});

let automationClient: SupabaseClient | null = null;
const AUTOMATION_TIMEOUT_MS = 20_000;

/**
 * Client sans session, réservé aux fonctions SQL d'automatisation.
 * Chacune vérifie le secret partagé : sans lui, ce client ne peut rien lire ni écrire.
 */
export function getAutomationClient(): SupabaseClient {
  automationClient ??= createClient(env.supabaseUrl, env.supabaseKey, {
    realtime,
    // Une synchronisation planifiée ne doit jamais rester suspendue à une base qui ne répond pas.
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(AUTOMATION_TIMEOUT_MS) }) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return automationClient;
}
