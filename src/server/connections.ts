import "server-only";

import type { ConnectionSummary } from "@/lib/domain/connections";
import { createSessionClient } from "@/server/supabase/clients";

/** Connexion fournisseur telle que l'administrateur la voit : aucune valeur secrète, seulement un indice. */
export type ProviderConnection = ConnectionSummary;

export interface ConnectionEvent {
  id: number;
  connectionId: string;
  type: string;
  detail: string | null;
  createdAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const toConnection = (row: any): ProviderConnection => ({
  id: row.id, provider: row.provider, mode: row.mode, organizationId: row.organization_id, label: row.label, status: row.status,
  credentialSource: row.credential_source, hint: row.hint ?? null, isDefault: row.is_default, lastVerifiedAt: row.last_verified_at,
  lastSyncAt: row.last_sync_at, lastSyncOk: row.last_sync_ok, lastError: row.last_error,
  pausedUntil: row.paused_until && Date.parse(row.paused_until) > Date.now() ? row.paused_until : null,
  createdAt: row.created_at, revokedAt: row.revoked_at, channels: row.channels ?? 0,
  unresolved: { scheduled: row.unresolved?.scheduled ?? 0, pending: row.unresolved?.pending ?? 0, uncertain: row.unresolved?.uncertain ?? 0 },
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Connexions fournisseur (administrateur uniquement : la base refuse tout autre rôle).
 * `null` : la base n'a pas reçu la migration 0012, l'écran l'indique au lieu de planter.
 */
export async function listProviderConnections(): Promise<ProviderConnection[] | null> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.rpc("admin_provider_connections");
  if (error?.code === "PGRST202") return null;
  if (error) throw new Error(`Lecture impossible (connexions) : ${error.message}`);
  return (data ?? []).map(toConnection);
}

/** Journal des connexions : création, clé remplacée, révocation. Ne contient jamais de valeur secrète. */
export async function listConnectionEvents(limit = 20): Promise<ConnectionEvent[]> {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.from("provider_connection_events").select("id, connection_id, type, detail, created_at").order("id", { ascending: false }).limit(limit);
  if (error) return [];
  return (data ?? []).map((row) => ({ id: row.id, connectionId: row.connection_id, type: row.type, detail: row.detail, createdAt: row.created_at }));
}
