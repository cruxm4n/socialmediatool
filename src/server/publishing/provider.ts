import type { BufferStatus, PostAsset } from "@/lib/types";

/**
 * Contrat du fournisseur de publication.
 * Aujourd'hui Buffer (réel ou simulé). Le reste du code ne connaît que cette interface.
 */

export interface ProviderChannel {
  id: string;
  service: string;
  name: string;
  displayName: string | null;
  avatar: string | null;
  isDisconnected: boolean;
  /** Rattachement proposé à la création du canal (utilisé par le Buffer simulé uniquement). */
  organizationSlug?: string;
  /** Connexion fournisseur dont ce canal provient (posée par le routeur de connexions). */
  connectionId?: string;
}

export interface ProviderPost {
  id: string;
  channelId: string;
  service: string;
  status: BufferStatus;
  text: string;
  dueAt: string | null;
  sentAt: string | null;
  updatedAt: string | null;
  externalLink: string | null;
  error: string | null;
  hasReviewTag: boolean;
  /** « automatic » ou « notification » (rappel de publication manuelle). */
  schedulingType: string | null;
  assets: PostAsset[];
  /** Connexion fournisseur dont cette publication provient (posée par le routeur de connexions). */
  connectionId?: string;
}

export type RateLimit = Record<string, number>;

export interface ProviderSnapshot {
  channels: ProviderChannel[];
  posts: ProviderPost[];
  /** false si la liste des posts est tronquée : on ne peut alors rien conclure sur les posts absents. */
  complete: boolean;
  /** true : plus de posts publiés existent que ceux lus. Sans effet sur « complete » (un post publié n'est jamais marqué retiré). */
  sentTruncated?: boolean;
  rateLimit: RateLimit | null;
  /**
   * Relevé issu de plusieurs connexions (routeur) : celles qui ont été lues EN ENTIER. Seules leurs publications
   * peuvent être déclarées retirées ; une connexion en panne, en pause ou révoquée ne fait rien disparaître.
   */
  scopeConnectionIds?: string[];
  /** Connexions qui n'ont pas pu être lues (panne, quota, secret illisible) : signalées, jamais ignorées en silence. */
  connectionErrors?: { connectionId: string; label: string; message: string }[];
}

/** Contenu d'un brouillon préparé dans le Studio de Cadence. */
export interface DraftContent {
  channelId: string;
  service: string;
  text: string;
  /** Date de publication prévue (UTC, ISO 8601). Le brouillon n'est pas programmé pour autant. */
  dueAt: string;
  /** Médias désignés par une adresse que le fournisseur peut télécharger. */
  assets: { type: "image" | "video"; url: string }[];
}

export interface PublishingProvider {
  readonly mode: "real" | "mock";
  /** État complet : canaux et posts. */
  fetchSnapshot(): Promise<ProviderSnapshot>;
  getPost(id: string): Promise<ProviderPost | null>;
  /** Passe un brouillon en « programmé » à sa date prévue. */
  schedulePost(post: ProviderPost): Promise<ProviderPost>;
  /** Repasse un post programmé en brouillon. */
  unschedulePost(post: ProviderPost): Promise<ProviderPost>;
  /**
   * Crée un BROUILLON portant le tag de validation. Ne programme et ne publie jamais :
   * la programmation reste réservée à schedulePost, après l'accord du client.
   */
  createDraft(content: DraftContent): Promise<ProviderPost>;
  /** Remplace le contenu d'un post et le laisse (ou le repasse) en brouillon. */
  updateDraft(postId: string, content: DraftContent): Promise<ProviderPost>;
  /** Change la date prévue d'un brouillon, sans toucher à son contenu. */
  rescheduleDraft(post: ProviderPost, dueAt: string): Promise<ProviderPost>;
  /**
   * Réconciliation après une création au résultat inconnu : interroge le fournisseur (lecture seule).
   * - candidates : correspondance exacte (canal, texte, date, nature des médias), tous statuts confondus ;
   * - possible : ressemblances (même canal, texte ou date identique) qu'une personne doit trancher ;
   * - complete : la lecture a couvert tout ce qu'on pouvait lire. Ne prouve JAMAIS l'absence d'un post :
   *   un texte modifié dans le fournisseur, une pagination limitée ou un média différent échappent à la recherche.
   * Ne crée ni ne modifie rien. Aucune garantie d'idempotence n'est supposée de la part du fournisseur.
   */
  findDraftCandidates(lookup: DraftLookup): Promise<{ candidates: ProviderPost[]; possible?: ProviderPost[]; complete: boolean }>;
}

/**
 * Erreur du fournisseur.
 * - `kind` : « api » (refus ou erreur applicative), « rate_limit » (quota), « network » (panne, délai).
 * - `outcome` : ce que l'on sait de l'effet de l'opération chez le fournisseur.
 *   « failed » : il n'a rien fait (refus, quota, clé refusée) — réessayer est sûr.
 *   « unknown » : la réponse a été perdue (délai, coupure, 5xx, réponse illisible) — il a peut-être agi.
 *   Pour une CRÉATION, un résultat « unknown » ne doit jamais déclencher une nouvelle création sans réconciliation.
 * - `createdPostId` : la création a réussi mais une étape suivante a échoué ; l'identifiant ne doit pas être perdu.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "api" | "rate_limit" | "network" = "api",
    readonly retryAfterSeconds?: number,
    readonly outcome: "failed" | "unknown" = "failed",
    readonly createdPostId?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /**
   * Connexion fournisseur concernée (posée par le routeur). Une erreur ainsi marquée ne vaut QUE pour ce compte :
   * elle ne suspend ni ne bloque les opérations des autres connexions.
   */
  connectionId?: string;

  /** Même erreur, avec l'identifiant d'un post créé avant l'échec. */
  withCreatedPost(postId: string): ProviderError {
    const copy = new ProviderError(this.message, this.kind, this.retryAfterSeconds, this.outcome, postId);
    copy.connectionId = this.connectionId;
    return copy;
  }
}

/** Critères pour retrouver, après un résultat incertain, un brouillon que Cadence a peut-être créé. */
export interface DraftLookup {
  channelId: string;
  text: string;
  dueAt: string;
  /** Nature des médias envoyés, dans l'ordre (« image » / « video »). Absent : non vérifié. */
  assetKinds?: string[];
}

/** Le contenu validé par le client est-il encore celui présent chez le fournisseur ? */
export function sameContent(
  approved: { text: string; dueAt: string | null; assets: PostAsset[] },
  live: Pick<ProviderPost, "text" | "dueAt" | "assets">,
): boolean {
  const instant = (iso: string | null) => iso === null ? null : Date.parse(iso);
  const approvedDate = instant(approved.dueAt);
  const liveDate = instant(live.dueAt);
  return (
    approved.text === live.text &&
    approvedDate === liveDate &&
    approved.assets.length === live.assets.length &&
    approved.assets.every((asset, index) => asset.type === live.assets[index].type && asset.source === live.assets[index].source)
  );
}
