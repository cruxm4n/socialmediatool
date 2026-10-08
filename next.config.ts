import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
