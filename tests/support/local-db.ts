import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

/*
 * Base PostgreSQL locale, en mémoire, jetable : elle sert à exécuter les migrations et les
 * fonctions SQL sans jamais toucher à Supabase. Chaque test repart d'une base vide.
 *
 * Ce que Supabase fournit d'office est reproduit au minimum : les rôles « anon » et
 * « authenticated », le schéma « auth » (comptes, auth.uid()), le schéma « storage » (espaces et
 * fichiers, sans le service de stockage lui-même) et les droits par défaut.
 * Ce n'est pas Supabase : l'API HTTP et la connexion par mot de passe ne sont pas testées ici.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");
export const SECRET = "secret-local-de-test";

const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth, extensions to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, unique (bucket_id, name));
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant all on storage.objects, storage.buckets to anon, authenticated;
`;

const templates: Record<string, Promise<Blob | File>> = {};

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

export type Actor = "anon" | { userId: string };
type Row = Record<string, unknown>;

export interface SyncPost {
  id: string;
  channelId?: string;
  status?: string;
  text?: string;
  dueAt?: string | null;
  hasReviewTag?: boolean;
  assets?: { type: string; source: string }[];
}

export class LocalDb {
  private constructor(private readonly pg: PGlite) {}

  /**
   * Base vide + migrations jusqu'à « upTo » incluse (toutes par défaut).
   * Les migrations sont exécutées une fois par série de tests ; chaque test reçoit ensuite
   * sa propre copie de la base obtenue, ce qui est bien plus rapide que de tout rejouer.
   */
  static async create(upTo = "9999"): Promise<LocalDb> {
    templates[upTo] ??= (async () => {
      const template = new LocalDb(new PGlite({ extensions: { pgcrypto } }));
      await template.pg.exec(SUPABASE_SHIM);
      for (const file of migrationFiles()) {
        if (file.slice(0, 4) <= upTo) await template.migrate(file);
      }
      const dump = await template.pg.dumpDataDir("none");
      await template.close();
      return dump;
    })();
    return new LocalDb(new PGlite({ extensions: { pgcrypto }, loadDataDir: await templates[upTo] }));
  }

  async migrate(file: string): Promise<void> {
    try {
      await this.pg.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Exécute un script SQL complet (plusieurs instructions) en tant que propriétaire. */
  async exec(script: string): Promise<void> {
    await this.pg.exec(script);
  }

  close(): Promise<void> {
    return this.pg.close();
  }

  /** Requête en tant que propriétaire de la base : préparation et contrôle des tests uniquement. */
  async sql<T = Row>(query: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(query, params)).rows;
  }

  /** Requête avec les droits d'un visiteur sans session ou d'un utilisateur connecté, comme via l'API. */
  async as<T = Row>(actor: Actor, query: string, params: unknown[] = []): Promise<T[]> {
    const role = actor === "anon" ? "anon" : "authenticated";
    await this.pg.query("select set_config('request.jwt.claim.sub', $1, false)", [actor === "anon" ? "" : actor.userId]);
    await this.pg.exec(`set role ${role}`);
    try {
      return (await this.pg.query<T>(query, params)).rows;
    } finally {
      await this.pg.exec("reset role");
      await this.pg.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  }

  /** Appel d'une fonction d'automatisation, sans session, comme le serveur de l'application. */
  async automation<T = Row>(name: string, args: Record<string, unknown>, secret = SECRET): Promise<T[]> {
    const entries = Object.entries({ p_secret: secret, ...args });
    const list = entries.map(([key, value], index) => `${key} => $${index + 1}${isJson(value) ? "::jsonb" : ""}`).join(", ");
    return this.as<T>("anon", `select * from public.${name}(${list})`, entries.map(([, value]) => (isJson(value) ? JSON.stringify(value) : value)));
  }

  /** Deux clients, un admin, un canal par client et le secret d'automatisation. */
  async seed() {
    await this.sql("insert into private.app_secrets (name, secret_hash) values ('automation', encode(extensions.digest($1::text, 'sha256'), 'hex'))", [SECRET]);
    const user = async (name: string, role: "admin" | "client") => {
      const [{ id }] = await this.sql<{ id: string }>("insert into auth.users (email) values ($1) returning id", [`${name}@test.example`]);
      await this.sql("insert into public.profiles (id, full_name, role) values ($1, $2, $3)", [id, name, role]);
      return { userId: id };
    };
    const organization = async (slug: string, member: { userId: string }) => {
      const [{ id }] = await this.sql<{ id: string }>("insert into public.organizations (slug, name, initials) values ($1, $1, 'XX') returning id", [slug]);
      await this.sql("insert into public.organization_members (organization_id, user_id) values ($1, $2)", [id, member.userId]);
      return id;
    };
    const admin = await user("admin", "admin");
    const ines = await user("ines", "client");
    const sofia = await user("sofia", "client");
    const colibri = await organization("colibri", ines);
    const nordwind = await organization("nordwind", sofia);
    return { admin, ines, sofia, colibri, nordwind };
  }

  /** Envoie un état de Buffer à la base, comme le fait la couche de service. */
  async sync(posts: SyncPost[], options: { mode?: "real" | "mock"; complete?: boolean; confirmedGone?: string[]; channelPrefix?: string } = {}) {
    // Les fixtures mixtes du schéma actuel isolent leurs canaux ; les montées de version conservent leurs identités historiques.
    const prefix = options.channelPrefix ?? "";
    const payload = {
      mode: options.mode ?? "real",
      complete: options.complete ?? false,
      confirmedGone: options.confirmedGone ?? [],
      channels: [
        { id: "canal-colibri", service: "linkedin", name: "Colibri", organizationSlug: "colibri" },
        { id: "canal-nordwind", service: "instagram", name: "Nordwind", organizationSlug: "nordwind" },
        { id: "canal-colibri-2", service: "linkedin", name: "Colibri (second compte)", organizationSlug: "colibri" },
        { id: "canal-libre", service: "instagram", name: "Libre" },
      ].map((channel) => ({ ...channel, id: `${prefix}${channel.id}` })),
      posts: posts.map((post) => ({
        id: post.id,
        channelId: post.channelId ?? `${prefix}canal-colibri`,
        service: "linkedin",
        status: post.status ?? "draft",
        text: post.text ?? "Texte",
        dueAt: post.dueAt === undefined ? FUTURE : post.dueAt,
        hasReviewTag: post.hasReviewTag ?? true,
        assets: post.assets ?? [],
      })),
    };
    const [row] = await this.automation<{ sync_buffer_posts: SyncCounts }>("sync_buffer_posts", { p_payload: payload });
    return row.sync_buffer_posts;
  }

  async post(bufferId: string) {
    const [row] = await this.sql<PostRow>("select * from public.posts where buffer_post_id = $1", [bufferId]);
    return row;
  }

  async decide(actor: Actor, bufferId: string, decision: "approved" | "changes_requested", comment: string | null = null) {
    const post = await this.post(bufferId);
    return this.as(actor, "select public.decide_post($1, $2, $3, $4)", [post.id, decision, post.content_hash, comment]);
  }
}

export const FUTURE = "2030-01-15T09:00:00.000Z";

export interface SyncCounts {
  fetched: number;
  created: number;
  updated: number;
  invalidated: number;
  removed: number;
  unresolved?: string[];
}

export interface PostRow {
  id: string;
  buffer_post_id: string;
  buffer_status: string;
  approval_status: string;
  schedule_state: string;
  content_hash: string;
  approved_hash: string | null;
  version: number;
  removed_at: Date | null;
  /** Jeton de réservation de programmation (migration 0009), à représenter à la confirmation. */
  token?: string | null;
}

function isJson(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}
