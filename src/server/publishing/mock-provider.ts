import { addDays, dayKeyOf, zonedToUtcIso } from "@/lib/dates";
import type { BufferStatus, PostAsset } from "@/lib/types";
import {
  ProviderError,
  type ProviderChannel,
  type ProviderPost,
  type ProviderSnapshot,
  type PublishingProvider,
} from "@/server/publishing/provider";

/*
 * Buffer simulé, en mémoire. Sert aux tests automatiques et à la démonstration hors ligne.
 * Ses identifiants commencent tous par « mock- » : ils ne se mélangent jamais aux vraies données.
 */

interface MockState {
  channels: ProviderChannel[];
  posts: ProviderPost[];
  failNextSchedule: string | null;
  scheduleCalls: number;
}

const PARIS = "Europe/Paris";

function image(file: string): PostAsset[] {
  const url = `/demo-media/${file}.svg`;
  return [{ type: "image", source: url, thumbnail: url, mimeType: "image/svg+xml" }];
}

function video(file: string): PostAsset[] {
  const url = `/demo-media/${file}.svg`;
  return [{ type: "video", source: url, thumbnail: url, mimeType: "video/mp4" }];
}

function buildState(runId: string): MockState {
  const today = dayKeyOf(new Date().toISOString(), PARIS);
  const at = (offset: number, time: string) => zonedToUtcIso(addDays(today, offset), time, PARIS);
  const channel = (org: string, service: string, name: string): ProviderChannel => ({
    id: `mock-ch-${org}-${service}`,
    service,
    name,
    displayName: name,
    avatar: null,
    isDisconnected: false,
    organizationSlug: org === "colibri" ? "maison-colibri" : "nordwind-cycles",
  });
  const post = (
    key: string,
    org: string,
    service: string,
    status: BufferStatus,
    hasReviewTag: boolean,
    dueAt: string,
    text: string,
    assets: PostAsset[] = [],
    extra: Partial<ProviderPost> = {},
  ): ProviderPost => ({
    id: `mock-${runId}-${key}`,
    channelId: `mock-ch-${org}-${service}`,
    service,
    status,
    text,
    dueAt,
    sentAt: status === "sent" ? dueAt : null,
    updatedAt: at(-1, "10:00"),
    externalLink: null,
    error: null,
    hasReviewTag,
    schedulingType: "automatic",
    assets,
    ...extra,
  });

  return {
    failNextSchedule: null,
    scheduleCalls: 0,
    channels: [
      channel("colibri", "linkedin", "Maison Colibri"),
      channel("colibri", "instagram", "maison.colibri"),
      channel("colibri", "facebook", "Maison Colibri Lyon"),
      channel("colibri", "tiktok", "maisoncolibri"),
      channel("nordwind", "linkedin", "Nordwind Cycles"),
      channel("nordwind", "instagram", "nordwind.cycles"),
      channel("nordwind", "facebook", "Nordwind Cycles"),
    ],
    posts: [
      post("guji-li", "colibri", "linkedin", "draft", true, at(5, "09:00"),
        "La nouvelle récolte de notre Éthiopie Guji est arrivée à l'atelier.\n\nCette année encore, nous travaillons avec la même coopérative, en achat direct. En tasse : fleur d'oranger, pêche blanche, et une longueur toute en douceur.\n\n#cafédespécialité #torréfaction #Lyon",
        image("colibri-guji")),
      post("guji-ig", "colibri", "instagram", "draft", true, at(5, "12:30"),
        "Le Guji est de retour ☕\n\nFleur d'oranger, pêche blanche, une tasse toute en douceur. Nouvelle récolte, même coopérative.\n\n#cafédespécialité #ethiopie #guji",
        image("colibri-guji")),
      post("atelier-ig", "colibri", "instagram", "draft", true, at(7, "18:30"),
        "Samedi, on ouvre l'atelier 👋\n\nTrois origines dégustées côte à côte, guidées par notre torréfactrice. Dix places seulement.\n\n#dégustation #café #lyon",
        image("colibri-atelier")),
      post("atelier-fb", "colibri", "facebook", "draft", true, at(7, "18:30"),
        "Atelier dégustation ce samedi à 10 h : trois origines comparées, dix places. Réservez la vôtre en boutique ou par message.",
        image("colibri-atelier")),
      post("coulisses-tt", "colibri", "tiktok", "draft", true, at(9, "17:30"),
        "6 h 30, le torréfacteur chauffe 🔥 Une matinée à l'atelier, du café vert jusqu'aux grains encore tièdes. #torréfaction #coulisses",
        video("colibri-torrefaction")),
      post("coldbrew-ig", "colibri", "instagram", "draft", false, at(12, "12:00"),
        "Le cold brew maison, c'est simple :\n\n1. Mouture grossière\n2. Eau froide\n3. Douze heures de patience\n\n#coldbrew #recette",
        image("colibri-coldbrew")),
      post("producteur-li", "colibri", "linkedin", "sent", false, at(-3, "09:00"),
        "Derrière chaque tasse, il y a des visages.\n\nNous travaillons en direct avec la coopérative qui cultive notre Guji.",
        image("colibri-producteur"), { externalLink: "https://www.linkedin.com/feed/" }),
      post("abonnement-fb", "colibri", "facebook", "error", false, at(-1, "12:30"),
        "L'abonnement d'automne est ouvert : deux cafés de saison livrés chaque mois.",
        image("colibri-abonnement"), { error: "Canal Facebook à reconnecter (erreur simulée)." }),
      post("abonnement-li", "colibri", "linkedin", "scheduled", false, at(2, "09:00"),
        "L'abonnement d'automne est ouvert.\n\nDeux cafés de saison livrés chaque mois, torréfiés la semaine de l'envoi.",
        image("colibri-abonnement")),
      post("fjord3-li", "nordwind", "linkedin", "draft", true, at(6, "08:30"),
        "Le Fjord 3 est disponible en précommande.\n\n200 kg de charge utile, un cadre abaissé pour charger sans effort et une assistance qui reste régulière en côte.\n\nPremières livraisons début décembre.\n\n#vélocargo #logistiqueurbaine",
        image("nordwind-fjord3")),
      post("fjord3-ig", "nordwind", "instagram", "draft", true, at(6, "12:00"),
        "Fjord 3 : les précommandes sont ouvertes 🚲\n\n200 kg de charge utile, cadre abaissé, assistance régulière.\n\n#vélocargo #fjord3",
        image("nordwind-fjord3")),
      post("temoignage-fb", "nordwind", "facebook", "draft", true, at(4, "12:00"),
        "Une boulangerie lilloise livre désormais tout son quartier à vélo cargo. Son retour d'expérience en quelques lignes.",
        image("nordwind-temoignage")),
      post("essai-li", "nordwind", "linkedin", "draft", true, at(14, "08:30"),
        "Tester avant de s'équiper : nous prêtons un vélo cargo pendant 48 heures aux professionnels de la métropole lilloise.\n\nVos trajets, vos charges, vos horaires. Sans engagement.",
        image("nordwind-essai")),
      // Soumis au client alors que sa date est déjà passée : il ne doit pas pouvoir être approuvé.
      post("expire-fb", "nordwind", "facebook", "draft", true, at(-1, "09:00"),
        "Dernier jour pour s'inscrire à la démonstration de demain matin."),
      post("entretien-ig", "nordwind", "instagram", "draft", false, at(13, "12:00"),
        "Avant l'hiver, cinq gestes pour votre vélo cargo : pneus, freins, chaîne, batterie, éclairage.\n\n#entretien #vélocargo",
        image("nordwind-entretien")),
      post("salon-li", "nordwind", "linkedin", "sent", false, at(-2, "08:30"),
        "Nous serons au Salon Mobilités de Lille, stand B12.",
        image("nordwind-salon"), { externalLink: "https://www.linkedin.com/feed/" }),
    ],
  };
}

const globalStore = globalThis as unknown as { __cadenceMockBuffer?: Record<string, MockState> };

function getState(runId: string): MockState {
  globalStore.__cadenceMockBuffer ??= {};
  globalStore.__cadenceMockBuffer[runId] ??= buildState(runId);
  return globalStore.__cadenceMockBuffer[runId];
}

export class MockProvider implements PublishingProvider {
  readonly mode = "mock" as const;

  constructor(private readonly runId: string) {}

  private get state() {
    return getState(this.runId);
  }

  private find(id: string): ProviderPost {
    const post = this.state.posts.find((item) => item.id === id);
    if (!post) throw new ProviderError("Post introuvable dans le Buffer simulé.");
    return post;
  }

  async fetchSnapshot(): Promise<ProviderSnapshot> {
    const state = this.state;
    return {
      channels: structuredClone(state.channels),
      posts: structuredClone(state.posts),
      complete: true,
      rateLimit: null,
    };
  }

  async getPost(id: string): Promise<ProviderPost | null> {
    const post = this.state.posts.find((item) => item.id === id);
    return post ? structuredClone(post) : null;
  }

  async schedulePost(post: ProviderPost): Promise<ProviderPost> {
    const state = this.state;
    state.scheduleCalls += 1;
    if (state.failNextSchedule) {
      const message = state.failNextSchedule;
      state.failNextSchedule = null;
      throw new ProviderError(message);
    }
    const stored = this.find(post.id);
    stored.status = "scheduled";
    stored.updatedAt = new Date().toISOString();
    return structuredClone(stored);
  }

  async unschedulePost(post: ProviderPost): Promise<ProviderPost> {
    const stored = this.find(post.id);
    stored.status = "draft";
    stored.updatedAt = new Date().toISOString();
    return structuredClone(stored);
  }

  /* --- Leviers réservés aux tests : ils imitent des actions faites à la main dans Buffer. --- */

  editText(id: string, text: string) {
    const stored = this.find(id);
    stored.text = text;
    stored.updatedAt = new Date().toISOString();
  }

  setStatus(id: string, status: BufferStatus) {
    this.find(id).status = status;
  }

  setReviewTag(id: string, hasReviewTag: boolean) {
    this.find(id).hasReviewTag = hasReviewTag;
  }

  remove(id: string) {
    const state = this.state;
    state.posts = state.posts.filter((item) => item.id !== id);
  }

  failNextSchedule(message: string) {
    this.state.failNextSchedule = message;
  }

  get scheduleCalls() {
    return this.state.scheduleCalls;
  }
}
