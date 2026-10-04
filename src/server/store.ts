/**
 * Persistence layer for analyzed stories, scan jobs and AI cache.
 *
 * Drivers:
 *  - "postgres": Drizzle + postgres.js, used when DATABASE_URL is set (prod)
 *  - "file": JSON files under DATA_DIR, used in dev / single-node deployments
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CommitEntry, RepoStory, ScanJob } from "@/lib/types";
import { SCHEMA_VERSION } from "@/lib/types";
import { config } from "./config";

export interface StoredStory {
  story: RepoStory;
  scannedAt: string;
  headSha: string;
}

export interface AnalysisStore {
  readonly driver: "postgres" | "file";
  init(): Promise<void>;
  ping(): Promise<boolean>;

  /** Latest story for a repo, or null. */
  getStory(owner: string, name: string): Promise<StoredStory | null>;
  getStoryForSha(owner: string, name: string, headSha: string): Promise<RepoStory | null>;
  /**
   * Persist the story and its commits. Commits are stored beside the document
   * rather than inside it, so page loads do not embed up to 1000 of them.
   */
  saveStory(story: RepoStory, commits: CommitEntry[]): Promise<void>;

  /** Commits analysed for a given HEAD, newest first. */
  getCommits(owner: string, name: string, headSha: string): Promise<CommitEntry[]>;

  /**
   * Repos with a stored story, newest scan first. Backs sitemap.xml — the
   * story URLs are the only thing here meant to be indexed.
   */
  listScannedRepos(limit?: number): Promise<Array<{ owner: string; name: string; scannedAt: string }>>;

  saveJob(job: ScanJob): Promise<void>;
  getJob(id: string): Promise<ScanJob | null>;
  updateJob(id: string, patch: Partial<ScanJob>): Promise<void>;

  aiCacheGet<T>(key: string): Promise<T | null>;
  aiCacheSet(key: string, value: unknown): Promise<void>;

  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* File driver                                                         */
/* ------------------------------------------------------------------ */

export class FileStore implements AnalysisStore {
  readonly driver = "file" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.root, "stories"), { recursive: true });
    await fs.mkdir(path.join(this.root, "jobs"), { recursive: true });
    await fs.mkdir(path.join(this.root, "ai"), { recursive: true });
  }

  async ping(): Promise<boolean> {
    try {
      await fs.access(this.root);
      return true;
    } catch {
      return false;
    }
  }

  #storyDir(owner: string, name: string): string {
    return path.join(this.root, "stories", `${owner.toLowerCase()}__${name.toLowerCase()}`);
  }

  async getStory(owner: string, name: string): Promise<StoredStory | null> {
    try {
      const raw = await fs.readFile(path.join(this.#storyDir(owner, name), "latest.json"), "utf8");
      const parsed = JSON.parse(raw) as StoredStory;
      if (parsed?.story?.schemaVersion !== SCHEMA_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async getStoryForSha(owner: string, name: string, headSha: string): Promise<RepoStory | null> {
    try {
      const raw = await fs.readFile(
        path.join(this.#storyDir(owner, name), `${headSha}.json`),
        "utf8"
      );
      return JSON.parse(raw) as RepoStory;
    } catch {
      return null;
    }
  }

  async saveStory(story: RepoStory, commits: CommitEntry[]): Promise<void> {
    const dir = this.#storyDir(story.repo.owner, story.repo.name);
    await fs.mkdir(dir, { recursive: true });
    const stored: StoredStory = {
      story,
      scannedAt: story.scannedAt,
      headSha: story.repo.headSha,
    };
    // Commits live beside the document, not inside it (see SCHEMA_VERSION).
    await fs.writeFile(
      path.join(dir, `${story.repo.headSha}.commits.json`),
      JSON.stringify(commits)
    );
    await fs.writeFile(path.join(dir, `${story.repo.headSha}.json`), JSON.stringify(story));
    await fs.writeFile(path.join(dir, "latest.json"), JSON.stringify(stored));
  }

  async getCommits(owner: string, name: string, headSha: string): Promise<CommitEntry[]> {
    try {
      const raw = await fs.readFile(
        path.join(this.#storyDir(owner, name), `${headSha}.commits.json`),
        "utf8"
      );
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CommitEntry[]) : [];
    } catch {
      return [];
    }
  }

  #jobPath(id: string): string {
    return path.join(this.root, "jobs", `${id}.json`);
  }

  async saveJob(job: ScanJob): Promise<void> {
    await fs.writeFile(this.#jobPath(job.id), JSON.stringify(job));
  }

  async getJob(id: string): Promise<ScanJob | null> {
    try {
      return JSON.parse(await fs.readFile(this.#jobPath(id), "utf8")) as ScanJob;
    } catch {
      return null;
    }
  }

  async updateJob(id: string, patch: Partial<ScanJob>): Promise<void> {
    const job = await this.getJob(id);
    if (!job) return;
    await fs.writeFile(this.#jobPath(id), JSON.stringify({ ...job, ...patch }));
  }

  #aiPath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.root, "ai", `${safe}.json`);
  }

  async aiCacheGet<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.#aiPath(key), "utf8")) as T;
    } catch {
      return null;
    }
  }

  async aiCacheSet(key: string, value: unknown): Promise<void> {
    await fs.mkdir(path.join(this.root, "ai"), { recursive: true });
    await fs.writeFile(this.#aiPath(key), JSON.stringify(value));
  }

  async listScannedRepos(limit = 5000): Promise<Array<{ owner: string; name: string; scannedAt: string }>> {
    try {
      const dirs = await fs.readdir(path.join(this.root, "stories"), { withFileTypes: true });
      const out: Array<{ owner: string; name: string; scannedAt: string }> = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const raw = await fs
          .readFile(path.join(this.root, "stories", d.name, "latest.json"), "utf8")
          .catch(() => null);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as StoredStory;
          const [owner, name] = d.name.split("__");
          if (owner && name) out.push({ owner, name, scannedAt: parsed.scannedAt });
        } catch {
          /* skip unreadable entry */
        }
      }
      out.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
      return out.slice(0, limit);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {}
}

/* ------------------------------------------------------------------ */
/* Postgres driver (Drizzle)                                           */
/* ------------------------------------------------------------------ */

class PostgresStore implements AnalysisStore {
  readonly driver = "postgres" as const;
  private client: import("postgres").Sql | null = null;
  private db: import("drizzle-orm/postgres-js").PostgresJsDatabase | null = null;

  async init(): Promise<void> {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { sql } = await import("drizzle-orm");
    this.client = postgres(config().databaseUrl!, { max: 10 });
    this.db = drizzle(this.client);
    // Idempotent bootstrap DDL (documented; swap for drizzle-kit migrations
    // if your team prefers versioned migration files).
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS stories (
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        story JSONB NOT NULL,
        PRIMARY KEY (owner, name, head_sha)
      )
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS scan_jobs (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ai_cache (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS stories_scanned_idx ON stories (scanned_at DESC)
    `);
    // Commits are stored apart from the story document so page loads do not
    // embed them (see SCHEMA_VERSION).
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS story_commits (
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        position INTEGER NOT NULL,
        commit JSONB NOT NULL,
        PRIMARY KEY (owner, name, head_sha, position)
      )
    `);
  }

  async ping(): Promise<boolean> {
    try {
      const { sql } = await import("drizzle-orm");
      await this.db!.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async getStory(owner: string, name: string): Promise<StoredStory | null> {
    const { sql } = await import("drizzle-orm");
    const rows = await this.db!.execute<Record<string, unknown>>(
      sql`SELECT story, scanned_at, head_sha FROM stories
          WHERE owner = ${owner.toLowerCase()} AND name = ${name.toLowerCase()}
          ORDER BY scanned_at DESC LIMIT 1`
    );
    const row = rows[0];
    if (!row) return null;
    const story = row.story as RepoStory;
    if (story?.schemaVersion !== SCHEMA_VERSION) return null;
    return { story, scannedAt: String(row.scanned_at), headSha: String(row.head_sha) };
  }

  async getStoryForSha(owner: string, name: string, headSha: string): Promise<RepoStory | null> {
    const { sql } = await import("drizzle-orm");
    const rows = await this.db!.execute<Record<string, unknown>>(
      sql`SELECT story FROM stories
          WHERE owner = ${owner.toLowerCase()} AND name = ${name.toLowerCase()}
            AND head_sha = ${headSha} LIMIT 1`
    );
    const row = rows[0];
    if (!row) return null;
    return row.story as RepoStory;
  }

  async saveStory(story: RepoStory, commits: CommitEntry[]): Promise<void> {
    const { sql } = await import("drizzle-orm");
    const owner = story.repo.owner.toLowerCase();
    const name = story.repo.name.toLowerCase();
    await this.db!.execute(
      sql`INSERT INTO stories (owner, name, head_sha, scanned_at, story)
          VALUES (${owner}, ${name},
                  ${story.repo.headSha}, ${story.scannedAt}, ${JSON.stringify(story)}::jsonb)
          ON CONFLICT (owner, name, head_sha)
          DO UPDATE SET story = EXCLUDED.story, scanned_at = EXCLUDED.scanned_at`
    );

    // Replace wholesale: a re-scan of the same HEAD may produce a different set.
    await this.db!.execute(
      sql`DELETE FROM story_commits
          WHERE owner = ${owner} AND name = ${name} AND head_sha = ${story.repo.headSha}`
    );
    for (let i = 0; i < commits.length; i++) {
      await this.db!.execute(
        sql`INSERT INTO story_commits (owner, name, head_sha, position, commit)
            VALUES (${owner}, ${name}, ${story.repo.headSha}, ${i},
                    ${JSON.stringify(commits[i])}::jsonb)`
      );
    }
  }

  async getCommits(owner: string, name: string, headSha: string): Promise<CommitEntry[]> {
    const { sql } = await import("drizzle-orm");
    try {
      const rows = await this.db!.execute<Record<string, unknown>>(
        sql`SELECT commit FROM story_commits
            WHERE owner = ${owner.toLowerCase()} AND name = ${name.toLowerCase()}
              AND head_sha = ${headSha}
            ORDER BY position ASC`
      );
      return rows.map((r) => r.commit as CommitEntry);
    } catch {
      return [];
    }
  }

  async saveJob(job: ScanJob): Promise<void> {
    const { sql } = await import("drizzle-orm");
    await this.db!.execute(
      sql`INSERT INTO scan_jobs (id, payload, updated_at)
          VALUES (${job.id}, ${JSON.stringify(job)}::jsonb, now())
          ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`
    );
  }

  async getJob(id: string): Promise<ScanJob | null> {
    const { sql } = await import("drizzle-orm");
    const rows = await this.db!.execute<Record<string, unknown>>(
      sql`SELECT payload FROM scan_jobs WHERE id = ${id} LIMIT 1`
    );
    const row = rows[0];
    return row ? (row.payload as ScanJob) : null;
  }

  async updateJob(id: string, patch: Partial<ScanJob>): Promise<void> {
    const job = await this.getJob(id);
    if (!job) return;
    await this.saveJob({ ...job, ...patch });
  }

  async aiCacheGet<T>(key: string): Promise<T | null> {
    const { sql } = await import("drizzle-orm");
    const rows = await this.db!.execute<Record<string, unknown>>(
      sql`SELECT value FROM ai_cache WHERE key = ${key} LIMIT 1`
    );
    const row = rows[0];
    return row ? (row.value as T) : null;
  }

  async aiCacheSet(key: string, value: unknown): Promise<void> {
    const { sql } = await import("drizzle-orm");
    await this.db!.execute(
      sql`INSERT INTO ai_cache (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
  }

  async listScannedRepos(limit = 5000): Promise<Array<{ owner: string; name: string; scannedAt: string }>> {
    const { sql } = await import("drizzle-orm");
    try {
      const rows = await this.db!.execute<Record<string, unknown>>(
        sql`SELECT DISTINCT ON (owner, name) owner, name, scanned_at
            FROM stories
            ORDER BY owner, name, scanned_at DESC
            LIMIT ${limit}`
      );
      return rows.map((r) => ({
        owner: String(r.owner),
        name: String(r.name),
        scannedAt: new Date(String(r.scanned_at)).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    await this.client?.end();
  }
}

/* ------------------------------------------------------------------ */

let storeSingleton: AnalysisStore | null = null;
let storeInit: Promise<AnalysisStore> | null = null;

declare global {
  var __ca_store: AnalysisStore | undefined;
}

export function store(): AnalysisStore {
  if (globalThis.__ca_store) return globalThis.__ca_store;
  if (!storeSingleton) {
    const cfg = config();
    storeSingleton =
      cfg.storeDriver === "postgres" && cfg.databaseUrl
        ? new PostgresStore()
        : new FileStore(cfg.dataDir);
  }
  return storeSingleton;
}

/** Ensures the store is initialized exactly once per process. */
export async function getStore(): Promise<AnalysisStore> {
  const s = store();
  storeInit ??= s.init().then(() => s);
  return storeInit;
}

// Re-export for type consumers
export type { ScanJob };
