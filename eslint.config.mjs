import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-test/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "test-results/**",
    "playwright-report/**",
    ".captures/**",
  ]),
  {
    // Contre-tests du contre-audit indépendant, importés TELS QUELS (leurs attentes ne sont pas modifiées).
    // Leur mise en forme n'est pas celle du projet : on ne la réécrit pas pour ne pas altérer ce qu'ils prouvent.
    files: ["tests/**/audit-independent*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
]);

export default eslintConfig;
