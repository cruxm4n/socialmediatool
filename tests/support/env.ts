import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Charge .env.local dans process.env sans écraser ce qui est déjà défini. */
export function loadLocalEnv(): void {
  let content: string;
  try {
    content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable manquante pour les tests : ${name} (voir .env.example).`);
  return value;
}
