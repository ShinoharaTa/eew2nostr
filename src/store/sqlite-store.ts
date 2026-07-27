import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AlertCategory, AlertStatusRecord } from "../core/status.js";
import type { StatusStore } from "./status-store.js";

interface Row {
  key: string;
  category: string;
  status: string;
  published_at: string;
  updated_at: string;
  serial: string | null;
  headline: string;
  detail: string;
  posts: string;
  revision: number;
}

const toRecord = (row: Row): AlertStatusRecord => ({
  key: row.key,
  category: row.category as AlertCategory,
  status: row.status as AlertStatusRecord["status"],
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
  serial: row.serial,
  headline: row.headline,
  detail: JSON.parse(row.detail),
  posts: JSON.parse(row.posts),
  revision: row.revision,
});

// ステータスの正となる SQLite 実装。
// node:sqlite は同期APIだが、他の実装に差し替えられるよう Promise を返す。
export class SqliteStatusStore implements StatusStore {
  private db: DatabaseSync | null = null;

  constructor(private filename: string) {}

  async init(): Promise<void> {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch (e) {
      throw new Error(
        "node:sqlite を読み込めませんでした。Node.js 24 以降で実行してください。",
        { cause: e },
      );
    }
    if (this.filename !== ":memory:") {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    }
    this.db = new sqlite.DatabaseSync(this.filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_status (
        key          TEXT PRIMARY KEY,
        category     TEXT NOT NULL,
        status       TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        serial       TEXT,
        headline     TEXT NOT NULL,
        detail       TEXT NOT NULL,
        posts        TEXT NOT NULL,
        revision     INTEGER NOT NULL,
        mirrored_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alert_status_unmirrored
        ON alert_status (mirrored_at);
    `);
  }

  async load(): Promise<AlertStatusRecord[]> {
    const rows = this.database()
      .prepare("SELECT * FROM alert_status ORDER BY published_at")
      .all() as unknown as Row[];
    return rows.map(toRecord);
  }

  async save(record: AlertStatusRecord): Promise<void> {
    this.database()
      .prepare(`
        INSERT INTO alert_status (
          key, category, status, published_at, updated_at,
          serial, headline, detail, posts, revision, mirrored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET
          category     = excluded.category,
          status       = excluded.status,
          published_at = excluded.published_at,
          updated_at   = excluded.updated_at,
          serial       = excluded.serial,
          headline     = excluded.headline,
          detail       = excluded.detail,
          posts        = excluded.posts,
          revision     = excluded.revision,
          mirrored_at  = NULL
      `)
      .run(
        record.key,
        record.category,
        record.status,
        record.publishedAt,
        record.updatedAt,
        record.serial,
        record.headline,
        JSON.stringify(record.detail),
        JSON.stringify(record.posts),
        record.revision,
      );
  }

  async listUnmirrored(): Promise<AlertStatusRecord[]> {
    const rows = this.database()
      .prepare(
        "SELECT * FROM alert_status WHERE mirrored_at IS NULL ORDER BY updated_at",
      )
      .all() as unknown as Row[];
    return rows.map(toRecord);
  }

  async markMirrored(key: string, revision: number): Promise<void> {
    // ミラー中にレコードが更新されていた場合は印を付けない(次のミラーに任せる)
    this.database()
      .prepare(
        "UPDATE alert_status SET mirrored_at = ? WHERE key = ? AND revision = ?",
      )
      .run(new Date().toISOString(), key, revision);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private database(): DatabaseSync {
    if (!this.db)
      throw new Error(
        "SqliteStatusStore is not initialized. call init() first.",
      );
    return this.db;
  }
}
