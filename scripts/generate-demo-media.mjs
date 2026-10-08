// Génère les visuels fictifs de démonstration dans public/demo-media.
// Usage : npm run demo:media
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "demo-media");
mkdirSync(outDir, { recursive: true });

const motifs = {
  cup: (w, h, c) => {
    const cx = w * 0.62, cy = h * 0.4, r = w * 0.3;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c.b}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.8}" fill="${c.c}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.62}" fill="${c.d}"/><path d="M${cx - r * 0.3} ${cy} q${r * 0.3} -${r * 0.35} ${r * 0.6} 0" stroke="${c.c}" stroke-width="${r * 0.06}" fill="none" stroke-linecap="round"/>`;
  },
  beans: (w, h, c) => {
    const spots = [[0.2, 0.2, 20], [0.52, 0.14, -30], [0.8, 0.26, 45], [0.34, 0.42, -15], [0.68, 0.46, 60], [0.9, 0.56, 10], [0.14, 0.56, 70]];
    return spots.map(([x, y, a], i) => `<g transform="translate(${w * x} ${h * y}) rotate(${a})"><ellipse rx="${w * 0.09}" ry="${w * 0.055}" fill="${i % 2 ? c.b : c.c}"/><path d="M-${w * 0.07} 0 q${w * 0.07} ${w * 0.03} ${w * 0.14} 0" stroke="${c.a}" stroke-width="${w * 0.008}" fill="none"/></g>`).join("");
  },
  sun: (w, h, c) =>
    `<circle cx="${w * 0.5}" cy="${h * 0.62}" r="${w * 0.42}" fill="${c.b}"/><circle cx="${w * 0.5}" cy="${h * 0.62}" r="${w * 0.28}" fill="${c.c}"/><rect x="0" y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="${c.a}"/>`,
  glass: (w, h, c) =>
    `<path d="M${w * 0.5} ${h * 0.1} h${w * 0.3} l-${w * 0.04} ${h * 0.5} h-${w * 0.22} z" fill="${c.b}"/><path d="M${w * 0.515} ${h * 0.28} h${w * 0.27} l-${w * 0.025} ${h * 0.3} h-${w * 0.22} z" fill="${c.d}"/><rect x="${w * 0.6}" y="${h * 0.33}" width="${w * 0.07}" height="${w * 0.07}" rx="8" fill="${c.c}" transform="rotate(12 ${w * 0.63} ${h * 0.36})"/><circle cx="${w * 0.2}" cy="${h * 0.24}" r="${w * 0.09}" fill="${c.c}"/>`,
  wheel: (w, h, c) => {
    const cx = w * 0.64, cy = h * 0.4, r = w * 0.3;
    const spokes = Array.from({ length: 12 }, (_, i) => {
      const a = (i * Math.PI) / 6;
      return `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a) * r}" y2="${cy + Math.sin(a) * r}" stroke="${c.b}" stroke-width="${w * 0.006}"/>`;
    }).join("");
    return `${spokes}<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.c}" stroke-width="${w * 0.035}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.14}" fill="${c.d}"/>`;
  },
  stripes: (w, h, c) =>
    Array.from({ length: 6 }, (_, i) => `<rect x="${w * (0.1 + i * 0.15)}" y="${h * (0.08 + (i % 3) * 0.05)}" width="${w * 0.09}" height="${h * 0.5}" rx="${w * 0.045}" fill="${i % 2 ? c.b : c.c}"/>`).join(""),
  grid: (w, h, c) =>
    Array.from({ length: 12 }, (_, i) => {
      const col = i % 4, row = Math.floor(i / 4);
      const fill = [c.b, c.c, c.d][(col + row) % 3];
      return `<rect x="${w * (0.12 + col * 0.2)}" y="${h * 0.1 + row * w * 0.2}" width="${w * 0.17}" height="${w * 0.17}" rx="${(col + row) % 2 ? w * 0.085 : w * 0.02}" fill="${fill}"/>`;
    }).join(""),
  arc: (w, h, c) =>
    `<path d="M${w * 0.1} ${h * 0.6} A${w * 0.4} ${w * 0.4} 0 0 1 ${w * 0.9} ${h * 0.6}" fill="none" stroke="${c.b}" stroke-width="${w * 0.1}"/><path d="M${w * 0.26} ${h * 0.6} A${w * 0.24} ${w * 0.24} 0 0 1 ${w * 0.74} ${h * 0.6}" fill="none" stroke="${c.c}" stroke-width="${w * 0.1}"/><circle cx="${w * 0.5}" cy="${h * 0.6}" r="${w * 0.07}" fill="${c.d}"/>`,
};

const warm = { a: "#2b1d14", b: "#c8743a", c: "#f0d9b5", d: "#6b3f24", text: "#fbf3e4" };
const cream = { a: "#f3e7d3", b: "#c8743a", c: "#2b1d14", d: "#e2b77a", text: "#2b1d14" };
const terracotta = { a: "#b5532a", b: "#f0d9b5", c: "#2b1d14", d: "#e9a15c", text: "#fff6ea" };
const forest = { a: "#22382c", b: "#e2b77a", c: "#f3e7d3", d: "#c8743a", text: "#f3e7d3" };
const navy = { a: "#10233f", b: "#3d7bd9", c: "#d6e6ff", d: "#f2c14e", text: "#f1f6ff" };
const ice = { a: "#e6eef8", b: "#10233f", c: "#3d7bd9", d: "#f2c14e", text: "#10233f" };
const signal = { a: "#f2c14e", b: "#10233f", c: "#ffffff", d: "#3d7bd9", text: "#10233f" };
const steel = { a: "#2f4a63", b: "#9fc3e8", c: "#f1f6ff", d: "#f2c14e", text: "#f1f6ff" };

const serif = "Georgia, 'Times New Roman', serif";
const sans = "'Helvetica Neue', Helvetica, Arial, sans-serif";

const assets = [
  ["colibri-guji", 1080, 1080, warm, "cup", serif, "NOUVELLE RÉCOLTE", ["Éthiopie", "Guji"]],
  ["colibri-atelier", 1080, 1080, cream, "beans", serif, "SAMEDI · 10 H", ["Atelier", "dégustation"]],
  ["colibri-coldbrew", 1080, 1080, forest, "glass", serif, "RECETTE", ["Cold brew", "maison"]],
  ["colibri-producteur", 1080, 1080, terracotta, "sun", serif, "PORTRAIT", ["La coopérative", "de Guji"]],
  ["colibri-abonnement", 1080, 1080, cream, "arc", serif, "ABONNEMENT", ["L'automne", "en grains"]],
  ["colibri-torrefaction", 1080, 1920, warm, "beans", serif, "COULISSES", ["Une matinée", "de torréfaction"]],
  ["colibri-guji-video", 1080, 1920, terracotta, "cup", serif, "EN 30 SECONDES", ["Guji,", "de la cerise", "à la tasse"]],
  ["nordwind-fjord3", 1080, 1080, navy, "wheel", sans, "PRÉCOMMANDES OUVERTES", ["Fjord 3"]],
  ["nordwind-temoignage", 1080, 1080, ice, "stripes", sans, "TÉMOIGNAGE", ["« On livre", "tout le quartier »"]],
  ["nordwind-salon", 1080, 1080, signal, "grid", sans, "SALON MOBILITÉS · LILLE", ["Stand B12"]],
  ["nordwind-entretien", 1080, 1080, steel, "wheel", sans, "AVANT L'HIVER", ["5 gestes", "d'entretien"]],
  ["nordwind-essai", 1080, 1080, ice, "arc", sans, "POUR LES PROS", ["Essai", "48 heures"]],
  ["nordwind-fjord3-video", 1080, 1920, navy, "wheel", sans, "FJORD 3", ["200 kg", "de charge utile"]],
];

for (const [name, w, h, c, motif, font, label, lines] of assets) {
  const size = w * (lines.some((line) => line.length > 14) ? 0.082 : 0.11);
  const lineHeight = size * 1.08;
  const baseY = h - w * 0.1 - (lines.length - 1) * lineHeight;
  const headline = lines
    .map((line, i) => `<text x="${w * 0.08}" y="${baseY + i * lineHeight}" font-family="${font}" font-size="${size}" font-weight="${font === sans ? 700 : 500}" fill="${c.text}" letter-spacing="${font === sans ? -2 : -1}">${line}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c.a}"/>${motifs[motif](w, h, c)}<text x="${w * 0.08}" y="${baseY - size * 1.15}" font-family="${sans}" font-size="${w * 0.028}" font-weight="700" letter-spacing="${w * 0.004}" fill="${c.text}" opacity="0.75">${label}</text>${headline}</svg>\n`;
  writeFileSync(join(outDir, `${name}.svg`), svg);
}

console.log(`${assets.length} visuels de démonstration générés dans public/demo-media`);
