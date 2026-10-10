import { describe, expect, it } from "vitest";

import {
  canMoveTo, composeText, findConflicts, hasBlockingIssue, normalizeHashtag, parseHashtags, STUDIO_ERRORS, textLength,
  validateDraft, validateFile, validateVariant, type ChannelSlot, type StudioMedia,
} from "@/lib/domain/studio";

const NOW = "2026-10-09T12:00:00.000Z";
const DUE = "2026-10-20T09:00:00.000Z";
const image = (overrides: Partial<StudioMedia> = {}): StudioMedia => ({ id: "i1", kind: "image", mimeType: "image/jpeg", sizeBytes: 500_000, width: 1080, height: 1080, durationMs: null, fileName: "photo.jpg", ...overrides });
const video = (overrides: Partial<StudioMedia> = {}): StudioMedia => ({ id: "v1", kind: "video", mimeType: "video/mp4", sizeBytes: 20_000_000, width: 1080, height: 1920, durationMs: 30_000, fileName: "clip.mp4", ...overrides });
const errors = (issues: { level: string; message: string }[]) => issues.filter((issue) => issue.level === "error").map((issue) => issue.message);

describe("hashtags", () => {
  it("nettoie une saisie libre : espaces, ponctuation, accents conservés", () => {
    expect(normalizeHashtag("café de spécialité")).toBe("#cafédespécialité");
    expect(normalizeHashtag("##Lyon!")).toBe("#Lyon");
    expect(normalizeHashtag(" - ")).toBeNull();
  });

  it("découpe, déduplique sans tenir compte de la casse, garde l'ordre", () => {
    expect(parseHashtags("#café, Torréfaction  lyon;#CAFÉ")).toEqual(["#café", "#Torréfaction", "#lyon"]);
    expect(parseHashtags("")).toEqual([]);
  });

  it("ajoute les hashtags communs à la fin, sans répéter ceux déjà dans le texte", () => {
    expect(composeText("Bonjour #Lyon  \n", ["#lyon", "#café"])).toBe("Bonjour #Lyon\n\n#café");
    expect(composeText("Bonjour", [])).toBe("Bonjour");
    expect(composeText("", ["#café"])).toBe("#café");
  });

  it("compte les caractères visibles : un émoji vaut un", () => {
    expect(textLength("Café ☕🔥")).toBe(7);
  });
});

describe("formats par réseau", () => {
  it("X : 280 caractères hashtags compris, quatre images au plus", () => {
    expect(errors(validateVariant("twitter", "a".repeat(275), ["#café"], []))).toEqual(["X : 282 caractères, 2 de trop (maximum 280, hashtags compris)."]);
    expect(errors(validateVariant("twitter", "Court", [], [1, 2, 3, 4, 5].map((n) => image({ id: `i${n}` }))))).toEqual(["X : 5 médias, maximum 4."]);
  });

  it("Instagram : média obligatoire, trente hashtags, carrousel jusqu'à dix, images et vidéos mêlées acceptées", () => {
    expect(errors(validateVariant("instagram", "Texte", [], []))).toEqual(["Instagram : un média est obligatoire."]);
    const many = Array.from({ length: 31 }, (_, index) => `#tag${index}`);
    expect(errors(validateVariant("instagram", "Texte", many, [image()]))).toEqual(["Instagram : 31 hashtags, maximum 30."]);
    expect(errors(validateVariant("instagram", "Texte", [], [image(), video(), image({ id: "i2" })]))).toEqual([]);
    expect(errors(validateVariant("instagram", "Texte", [], Array.from({ length: 11 }, (_, index) => image({ id: `i${index}` }))))).toEqual(["Instagram : 11 médias, maximum 10."]);
    expect(errors(validateVariant("instagram", "Texte", [], [image({ mimeType: "image/gif", fileName: "anim.gif" })]))).toEqual(["Instagram : les GIF ne sont pas acceptés (« anim.gif »)."]);
  });

  it("Instagram : prévient d'un recadrage sans bloquer", () => {
    const issues = validateVariant("instagram", "Texte", [], [image({ width: 1080, height: 1920, fileName: "story.jpg" })]);
    expect(issues).toEqual([{ level: "warning", message: "Instagram : « story.jpg » sera recadré (format accepté entre 4:5 et 1,91:1)." }]);
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it("TikTok : une vidéo, obligatoire, dix minutes au plus", () => {
    expect(errors(validateVariant("tiktok", "Texte", [], []))).toEqual(["TikTok : un média est obligatoire (vidéo)."]);
    expect(errors(validateVariant("tiktok", "Texte", [], [image()]))).toEqual(["TikTok : seules les vidéos sont acceptées."]);
    expect(errors(validateVariant("tiktok", "Texte", [], [video({ durationMs: 700_000 })]))).toEqual(["TikTok : vidéo de 700 s, maximum 600 s (« clip.mp4 »)."]);
    expect(errors(validateVariant("tiktok", "Texte", [], [video()]))).toEqual([]);
  });

  it("LinkedIn et Facebook : texte seul accepté, pas d'images et de vidéo mêlées", () => {
    expect(errors(validateVariant("linkedin", "Texte", [], []))).toEqual([]);
    expect(errors(validateVariant("facebook", "Texte", [], [image(), video()]))).toEqual(["Facebook : images et vidéo ne peuvent pas être mêlées dans une même publication."]);
    expect(errors(validateVariant("linkedin", "", [], []))).toEqual(["LinkedIn : ajoutez un texte ou un média."]);
  });

  it("au dépôt : format et poids", () => {
    expect(validateFile({ name: "a.jpg", type: "image/jpeg", size: 1000 })).toBeNull();
    expect(validateFile({ name: "a.pdf", type: "application/pdf", size: 1000 })?.message).toContain("format non pris en charge");
    expect(validateFile({ name: "gros.mp4", type: "video/mp4", size: 60 * 1024 * 1024 })?.message).toContain("50 Mo");
  });
});

describe("contrôles avant envoi en validation", () => {
  const channels: ChannelSlot[] = [
    { id: "c-li", network: "linkedin", name: "Maison Colibri", isDisconnected: false },
    { id: "c-ig", network: "instagram", name: "maison.colibri", isDisconnected: false },
    { id: "c-fb", network: "facebook", name: "Colibri Lyon", isDisconnected: true },
  ];
  const draft = (overrides = {}) => ({ dueAt: DUE, hashtags: [], media: [image()], variants: [{ channelId: "c-li", text: "Bonjour" }], ...overrides });

  it("un contenu complet passe", () => {
    expect(validateDraft(draft(), channels, NOW)).toEqual([]);
  });

  it("exige un canal, une date à venir, et applique les règles de chaque réseau à son texte", () => {
    expect(errors(validateDraft(draft({ variants: [] }), channels, NOW))).toEqual(["Choisissez au moins un canal."]);
    expect(errors(validateDraft(draft({ dueAt: null }), channels, NOW))).toEqual(["Choisissez la date et l'heure de publication."]);
    expect(errors(validateDraft(draft({ dueAt: "2026-10-09T12:02:00.000Z" }), channels, NOW))).toEqual(["La date de publication est passée ou trop proche."]);
    const mixed = draft({ media: [], variants: [{ channelId: "c-li", text: "Bonjour" }, { channelId: "c-ig", text: "Bonjour" }] });
    expect(errors(validateDraft(mixed, channels, NOW))).toEqual(["Instagram : un média est obligatoire."]);
  });

  it("refuse un canal déconnecté ou qui n'appartient plus au client", () => {
    expect(errors(validateDraft(draft({ variants: [{ channelId: "c-fb", text: "Bonjour" }] }), channels, NOW))[0]).toContain("déconnecté dans Buffer");
    expect(errors(validateDraft(draft({ variants: [{ channelId: "ailleurs", text: "Bonjour" }] }), channels, NOW))).toEqual(["Un canal sélectionné n'appartient plus à ce client."]);
  });
});

describe("calendrier", () => {
  const scheduled = [
    { id: "a", channelId: "c-li", dueAt: "2026-10-20T09:20:00.000Z", title: "Proche" },
    { id: "b", channelId: "c-li", dueAt: "2026-10-20T11:00:00.000Z", title: "Loin" },
    { id: "c", channelId: "c-ig", dueAt: "2026-10-20T09:00:00.000Z", title: "Autre canal" },
    { id: "d", channelId: "c-li", dueAt: null, title: "Sans date" },
  ];

  it("signale une autre publication du même canal à moins de trente minutes", () => {
    expect(findConflicts(DUE, ["c-li"], scheduled).map((item) => item.id)).toEqual(["a"]);
    expect(findConflicts(DUE, ["c-li", "c-ig"], scheduled).map((item) => item.id)).toEqual(["a", "c"]);
    expect(findConflicts(DUE, ["c-li"], scheduled, ["a"])).toEqual([]);
    expect(findConflicts(null, ["c-li"], scheduled)).toEqual([]);
  });

  it("refuse un déplacement vers le passé", () => {
    expect(canMoveTo(DUE, NOW)).toBe(true);
    expect(canMoveTo("2026-10-08T09:00:00.000Z", NOW)).toBe(false);
  });
});

describe("messages", () => {
  it("chaque refus de la base a un message lisible", () => {
    const codes = ["forbidden", "not_found", "organization_unavailable", "draft_archived", "stale_revision", "invalid_hashtags", "too_many_media", "invalid_media",
      "invalid_channel", "text_too_long", "variant_in_buffer", "date_invalid", "no_variant", "push_in_progress", "push_uncertain",
      "invalid_media_type", "invalid_media_size", "invalid_media_path", "media_not_uploaded"];
    for (const code of codes) expect(STUDIO_ERRORS[code], code).toMatch(/^[A-ZÉ]/);
  });
});

describe("contenus du Studio dans le calendrier", async () => {
  const { studioDraftIdOf, studioPostViews } = await import("@/lib/view");
  const organization = { id: "o1", slug: "colibri", name: "Colibri", sector: "", timezone: "America/Montreal", initials: "CO", color: "#000000", archivedAt: null };
  const channel = (id: string, service: string) => ({ id, bufferChannelId: `buf-${id}`, service, name: id, displayName: null, avatarUrl: null, isDisconnected: false, organizationId: "o1", lastOrganizationId: "o1", visibleFrom: null });
  const asset = (id: string, kind: "image" | "video", url: string | null) => ({ id, organizationId: "o1", fileName: id, kind, mimeType: kind === "image" ? "image/jpeg" : "video/mp4", sizeBytes: 1, width: null, height: null, durationMs: null, createdAt: NOW, archivedAt: null, url });
  const base = { organizationId: "o1", title: "", dueAt: DUE, hashtags: ["#café"], mediaIds: ["img", "vid", "sans-adresse"], revision: 1, createdAt: NOW, updatedAt: NOW, submittedAt: null };
  const variant = (id: string, channelId: string, bufferPostId: string | null = null) => ({ id, channelId, text: "Bonjour", bufferPostId, pushState: "idle" as const, pushError: null, pushedRevision: null });

  it("une entrée par canal pas encore envoyé, avec le texte publié, les médias et le fuseau du client", () => {
    const views = studioPostViews(
      [
        { ...base, id: "d1", status: "draft", variants: [variant("v1", "c-li"), variant("v2", "c-ig", "deja-dans-buffer"), variant("v3", "canal-disparu")] },
        { ...base, id: "d2", status: "archived", variants: [variant("v4", "c-li")] },
      ],
      [channel("c-li", "linkedin"), channel("c-ig", "instagram")],
      [organization],
      [asset("img", "image", "https://s/img"), asset("vid", "video", "https://s/vid"), asset("sans-adresse", "image", null)],
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: "studio:d1:v1", status: "draft", network: "linkedin", text: "Bonjour\n\n#café", title: "Bonjour", timezone: "America/Montreal", bufferStatus: "draft", approvalStatus: "none" });
    // Une vidéo sans vignette est affichée par le navigateur lui-même ; un média sans adresse est omis.
    expect(views[0].assets).toEqual([
      { type: "image", source: "https://s/img", thumbnail: "https://s/img", mimeType: "image/jpeg" },
      { type: "video", source: "https://s/vid", thumbnail: "", mimeType: "video/mp4" },
    ]);
    expect(studioDraftIdOf(views[0].id)).toBe("d1");
    expect(studioDraftIdOf("3f2c0000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("reconnaissance du code d'erreur de la base", async () => {
  const { errorCodeIn } = await import("@/lib/domain/errors");
  const { ADMIN_ERRORS } = await import("@/lib/domain/clients");

  it("un code n'est pas reconnu à l'intérieur d'un code plus long (bug observé sur la base réelle)", () => {
    expect(errorCodeIn("user_not_found", Object.keys(ADMIN_ERRORS))).toBe("user_not_found");
    expect(errorCodeIn("not_found", Object.keys(ADMIN_ERRORS))).toBe("not_found");
    expect(errorCodeIn("invalid_media_type", Object.keys(STUDIO_ERRORS))).toBe("invalid_media_type");
    expect(errorCodeIn("invalid_media", Object.keys(STUDIO_ERRORS))).toBe("invalid_media");
    expect(errorCodeIn("P0001: invalid_media_path (contexte PL/pgSQL)", Object.keys(STUDIO_ERRORS))).toBe("invalid_media_path");
    expect(errorCodeIn("erreur inattendue", Object.keys(STUDIO_ERRORS))).toBeUndefined();
    expect(errorCodeIn(undefined, ["not_found"])).toBeUndefined();
  });
});

describe("limites vérifiées auprès de Buffer (audit, phase 4)", () => {
  const img = [{ id: "m", kind: "image" as const, mimeType: "image/jpeg", sizeBytes: 1, width: 1080, height: 1080, durationMs: null, fileName: "a.jpg" }];
  const errors = (network: "instagram" | "facebook", text: string, tags: string[] = []) =>
    validateVariant(network, text, tags, img).filter((issue) => issue.level === "error").length;

  it("Instagram : 2 196 caractères, pas 2 200", () => {
    expect(errors("instagram", "a".repeat(2196))).toBe(0);
    expect(errors("instagram", "a".repeat(2197))).toBe(1);
  });

  it("Facebook : 5 000 caractères via l'API Buffer", () => {
    expect(errors("facebook", "a".repeat(5000))).toBe(0);
    expect(errors("facebook", "a".repeat(5001))).toBe(1);
  });

  it("Instagram : au-delà de 5 hashtags, simple avertissement ; au-delà de 30, erreur", () => {
    const tags = (n: number) => Array.from({ length: n }, (_, index) => `#t${index}`);
    const warnings = (n: number) => validateVariant("instagram", "Texte", tags(n), img).filter((issue) => issue.level === "warning").length;
    expect(warnings(5)).toBe(0);
    expect(warnings(6)).toBe(1);
    expect(errors("instagram", "Texte", tags(31))).toBe(1);
  });

  it("une publication doit être envoyée au moins 15 minutes avant son échéance (au-dessus de la marge d'approbation)", () => {
    const now = "2030-01-15T09:00:00.000Z";
    const channels = [{ id: "c", network: "linkedin" as const, name: "L", isDisconnected: false }];
    const draft = (dueAt: string) => validateDraft({ dueAt, hashtags: [], media: [], variants: [{ channelId: "c", text: "x" }] }, channels, now);
    expect(hasBlockingIssue(draft("2030-01-15T09:10:00.000Z"))).toBe(true);
    expect(hasBlockingIssue(draft("2030-01-15T09:20:00.000Z"))).toBe(false);
  });
});
