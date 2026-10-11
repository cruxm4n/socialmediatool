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
  /** « revoking » : révocation demandée — plus aucun nouvel effet, la clé reste pour annuler ce qui est engagé. */
  status: "active" | "revoking" | "revoked";
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
  /** Compte constaté chez le fournisseur lors de la vérification de la clé (nom, ou adresse masquée). */
  accountLabel: string | null;
  /** L'identité du compte a été constatée par le serveur (toujours vrai pour un compte simulé). */
  verified: boolean;
  /** Numéro de la clé maître qui chiffre la clé enregistrée. */
  keyVersion: number | null;
  /** Lectures planifiées espacées jusqu'à cette date (quota presque épuisé). */
  readBackoffUntil: string | null;
  /** Quota restant par fenêtre, tel que renvoyé par le fournisseur à la dernière réponse. */
  rateLimit: Record<string, number> | null;
}

/** Détail d'une connexion : ses réseaux, ses programmations en attente, ses envois non résolus. */
export interface ConnectionDetail {
  channels: { id: string; service: string; name: string; organizationId: string | null; isDisconnected: boolean }[];
  scheduled: { id: string; bufferPostId: string; service: string; channel: string; dueAt: string | null; scheduleState: string; bufferStatus: string; error: string | null; excerpt: string }[];
  uncertain: { variantId: string; draftId: string; service: string; channel: string; pushState: string; attemptId: string | null; claimedAt: string | null; error: string | null; orphans: number }[];
}

/** Libellé d'une programmation en attente. */
export function scheduleStateLabel(state: string, bufferStatus: string): string {
  if (state === "unschedule_pending") return "Annulation à confirmer dans Buffer";
  if (state === "claimed") return "Programmation en cours (résultat non confirmé)";
  if (state === "scheduled" || bufferStatus === "scheduled") return "Programmée dans Buffer";
  return state;
}

/** Libellé d'un envoi Studio non résolu. Un identifiant de tentative n'est jamais masqué : il sert à la résolution. */
export function pushStateLabel(state: string, orphans: number): string {
  if (state === "unknown") return "Résultat inconnu : à rapprocher avant tout nouvel envoi";
  if (state === "pushing") return "Envoi en cours ou interrompu";
  return orphans > 0 ? `${orphans} brouillon(s) orphelin(s) consigné(s)` : state;
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
    return { label: "Révoquée", tone: "muted", detail: "Sa clé est effacée : Cadence n'envoie plus rien par ce compte. Son historique est conservé." };
  }
  if (connection.status === "revoking") {
    return { label: "Révocation demandée", tone: "amber", detail: "Plus aucune nouvelle opération ne part par ce compte. Sa clé est conservée le temps d'annuler ou de rapprocher ce qui est déjà engagé." };
  }
  if (connection.mode !== serverMode) {
    return connection.mode === "real"
      ? { label: connection.verified ? "Enregistrée, non utilisée" : "Non vérifiée, non utilisée", tone: "muted", detail: "Le serveur est en mode simulé : ce compte réel n'est ni lu ni utilisé, et aucun appel à Buffer n'a lieu." }
      : { label: "Inactive en mode réel", tone: "muted", detail: "Compte simulé : il ne sert pas quand le serveur utilise le vrai Buffer." };
  }
  if (!connection.verified) {
    return { label: "Non vérifiée", tone: "red", detail: "Le compte auquel appartient cette clé n'a pas été constaté auprès de Buffer : elle ne sert à aucune opération. Utilisez « Vérifier »." };
  }
  if (connection.pausedUntil) {
    return { label: "En pause (quota)", tone: "amber", detail: `Quota de ce compte atteint : aucune requête par ce compte avant le ${connection.pausedUntil.slice(0, 16).replace("T", " à ")} UTC. La pause est propre à ce compte.` };
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
    shared: connections.filter((connection) => connection.organizationId === null && connection.status !== "revoked"),
  };
}

/**
 * Ce serveur a-t-il un compte Buffer utilisable pour ce mode ? Sert à afficher « Aucun compte Buffer connecté » et à
 * désactiver les actions qui ont besoin de Buffer. Un compte non vérifié ou révoqué ne compte pas.
 */
export function hasUsableConnection(connections: ConnectionSummary[], serverMode: "real" | "mock", organizationId?: string): boolean {
  return connections.some((connection) =>
    connection.mode === serverMode && connection.status === "active" && connection.verified
    && (organizationId === undefined || connection.organizationId === organizationId || connection.organizationId === null));
}
