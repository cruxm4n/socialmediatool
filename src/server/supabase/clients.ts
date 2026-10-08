import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import WebSocket from "ws";

import { env } from "@/server/env";

// supabase-js exige un WebSocket même si le temps réel n'est pas utilisé ; Node 20 n'en fournit pas.
const realtime = { transport: WebSocket as unknown as typeof globalThis.WebSocket };

/** Client lié à la session de l'utilisateur : toutes les lectures passent par les règles RLS. */
export async function createSessionClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseKey, {
    realtime,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        try {
          for (const { name, value, options } of items) cookieStore.set(name, value, options);
        } catch {
          // Appelé depuis un composant serveur : l'écriture de cookies y est impossible.
          // La session est rafraîchie par src/proxy.ts.
        }
      },
    },
  });
}

let automationClient: SupabaseClient | null = null;

/**
 * Client sans session, réservé aux fonctions SQL d'automatisation.
 * Chacune vérifie le secret partagé : sans lui, ce client ne peut rien lire ni écrire.
 */
export function getAutomationClient(): SupabaseClient {
  automationClient ??= createClient(env.supabaseUrl, env.supabaseKey, {
    realtime,
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return automationClient;
}
