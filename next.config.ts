import type { NextConfig } from "next";

/** En-têtes de sécurité appliqués à toutes les réponses. */
const securityHeaders = [
  // L'application ne s'affiche jamais dans le cadre d'un autre site (détournement de clic).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Le Dockerfile définit BUILD_STANDALONE=1 pour produire un serveur autonome (.next/standalone).
  // En local, `npm run start` a besoin de la sortie classique.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
