import type { Channel, Organization } from "@/lib/types";

/** Règles de gestion des clients, sans accès aux données : utilisables côté serveur comme dans le navigateur. */

const strip = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Adresse du client dans l'URL de son espace : minuscules, chiffres et tirets. */
export function slugify(name: string): string {
  return strip(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Initiales affichées dans la pastille du client : deux mots → deux initiales, un mot → ses deux premières lettres. */
export function initialsFor(name: string): string {
  const words = strip(name).replace(/[^a-zA-Z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0].charAt(0) + words[1].charAt(0);
  return letters.toUpperCase();
}

/** Couleurs proposées pour la pastille d'un client : assez sombres pour un texte blanc. */
export const CLIENT_COLORS = ["#1f4f8f", "#0f766e", "#7c3aed", "#b45309", "#be123c", "#334155"] as const;

export const CLIENT_TIMEZONES = [
  "Europe/Paris",
  "Europe/London",
  "Europe/Brussels",
  "Europe/Zurich",
  "America/Montreal",
  "America/New_York",
  "Asia/Taipei",
  "UTC",
] as const;

export const isArchived = (organization: Pick<Organization, "archivedAt">) => organization.archivedAt !== null;

const normalize = (value: string) => strip(value).toLowerCase();

/** Recherche simple sur le nom, le secteur et les canaux d'un client. */
export function matchesClientSearch(organization: Organization, channels: Channel[], query: string): boolean {
  const needle = normalize(query.trim());
  if (needle.length === 0) return true;
  const haystack = [organization.name, organization.sector, ...channels.flatMap((channel) => [channel.name, channel.displayName ?? "", channel.service])];
  return normalize(haystack.join(" ")).includes(needle);
}

/** Canaux à traiter d'abord : ceux qui n'appartiennent à aucun client, puis par réseau et par nom. */
export function sortChannels(channels: Channel[]): Channel[] {
  return [...channels].sort(
    (a, b) =>
      Number(a.organizationId !== null) - Number(b.organizationId !== null) ||
      a.service.localeCompare(b.service) ||
      (a.displayName || a.name).localeCompare(b.displayName || b.name),
  );
}

/** Messages lisibles pour les refus des fonctions SQL d'administration. */
export const ADMIN_ERRORS: Record<string, string> = {
  not_authenticated: "Votre session a expiré. Reconnectez-vous.",
  forbidden: "Réservé à l'administrateur.",
  not_found: "Élément introuvable : rechargez la page.",
  invalid_name: "Le nom est obligatoire (80 caractères au plus).",
  name_taken: "Un client porte déjà ce nom.",
  invalid_timezone: "Fuseau horaire inconnu.",
  invalid_color: "Couleur invalide.",
  invalid_initials: "Ce nom ne permet pas de former des initiales : ajoutez des lettres ou des chiffres.",
  invalid_slug: "Ce nom ne permet pas de former une adresse : ajoutez des lettres ou des chiffres.",
  organization_unavailable: "Ce client est archivé ou n'existe plus : restaurez-le avant de lui attribuer un canal.",
  not_a_client: "Seul un compte client peut être associé à un client (pas un administrateur).",
  user_not_found: "Aucun compte ne correspond à cet e-mail.",
  channel_connection_org_mismatch: "Ce canal vient du compte Buffer d'un autre client : il ne peut être attribué qu'à ce client.",
  channel_connection_immutable: "Un canal reste lié au compte Buffer dont il provient : il ne change pas de compte.",
};
