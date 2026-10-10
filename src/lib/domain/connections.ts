/*
 * Règles d'affichage des connexions fournisseur (comptes Buffer). Pures : testées dans tests/unit.
 * Une connexion n'est présentée « active » que si elle peut réellement servir : un compte réel enregistré sur un
 * serveur en mode simulé n'est PAS actif, et un compte simulé n'est jamais présenté comme un vrai compte.
 */

export interface ConnectionSummary {
  id: string;
  provider: string;
  mode: "real" | "mock";
  organizationId: string | null;
  label: string;
  status: "active" | "revoked";
  credentialSource: "none" | "environment" | "stored";
  hint: string | null;
  isDefault: boolean;
  lastVerifiedAt: string | null;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  pausedUntil: string | null;
  createdAt: string;
  revokedAt: string | null;
  channels: number;
  unresolved: { scheduled: number; pending: number; uncertain: number };
}

export type ConnectionTone = "green" | "amber" | "red" | "muted";

export interface ConnectionStatus {
  label: string;
  tone: ConnectionTone;
  detail: string | null;
}

/** État affiché d'une connexion, selon le mode du serveur (« real » : Buffer réel ; « mock » : simulation). */
export function connectionStatus(connection: ConnectionSummary, serverMode: "real" | "mock"): ConnectionStatus {
  if (connection.status === "revoked") {
    return { label: "Révoquée", tone: "muted", detail: "Plus aucune opération ne passe par ce compte. Son historique est conservé." };
  }
  if (connection.mode !== serverMode) {
    return connection.mode === "real"
      ? { label: "Enregistrée, non utilisée", tone: "muted", detail: "Le serveur est en mode simulé : ce compte réel n'est ni lu ni utilisé, et aucun appel à Buffer n'a lieu." }
      : { label: "Inactive en mode réel", tone: "muted", detail: "Compte simulé : il ne sert pas quand le serveur utilise le vrai Buffer." };
  }
  if (connection.pausedUntil) {
    return { label: "En pause (quota)", tone: "amber", detail: `Quota de ce compte atteint : aucune requête avant le ${connection.pausedUntil.slice(0, 16).replace("T", " à ")} UTC. Les autres comptes ne sont pas concernés.` };
  }
  if (connection.lastSyncOk === false) return { label: "En erreur", tone: "red", detail: null };
  if (!connection.lastSyncAt) return { label: "Jamais lue", tone: "muted", detail: "Ce compte sera lu à la prochaine synchronisation." };
  return connection.mode === "mock"
    ? { label: "Simulation active", tone: "amber", detail: "Données fictives : rien n'est envoyé à Buffer." }
    : { label: "Active", tone: "green", detail: null };
}

/** Ce que l'on montre du secret : sa nature et, au plus, quatre caractères. Jamais la clé. */
export function credentialLabel(connection: Pick<ConnectionSummary, "credentialSource" | "hint">): string {
  if (connection.credentialSource === "none") return "aucun secret (simulation)";
  if (connection.credentialSource === "environment") return "clé du serveur (compte historique)";
  return connection.hint ? `clé chiffrée ••••${connection.hint.slice(-4)}` : "clé chiffrée";
}

/** Connexions utilisables pour un client : les siennes, puis les connexions partagées de l'agence. */
export function connectionsForOrganization(connections: ConnectionSummary[], organizationId: string): { own: ConnectionSummary[]; shared: ConnectionSummary[] } {
  return {
    own: connections.filter((connection) => connection.organizationId === organizationId),
    shared: connections.filter((connection) => connection.organizationId === null && connection.status === "active"),
  };
}
