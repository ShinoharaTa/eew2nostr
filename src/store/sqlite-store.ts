import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AlertCategory, AlertStatusRecord } from "../core/status.js";
import type { StatusStore } from "./status-store.js";

interface Row {
  key: string;
  category: string;
  kind: string | null;
  severity: string | null;
  status: string;
  published_at: string;
  updated_at: string;
  expires_at: string | null;
  serial: string | null;
  headline: string;
  area: string | null;
  area_type: string | null;
  detail: string;
  posts: string;
  deliveries: string | null;
  revision: number;
}

const toRecord = (row: Row): AlertStatusRecord => ({
  key: row.key,
  category: row.category as AlertCategory,
  // 旧スキーマの行には kind / severity が無いため既定値で補う
  kind: (row.kind ?? "forecast") as AlertStatusRecord["kind"],
  severity: (row.severity ?? "info") as AlertStatusRecord["severity"],
  status: row.status as AlertStatusRecord["status"],
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at ?? null,
  serial: row.serial,
  headline: row.headline,
  area: row.area ? JSON.parse(row.area) : null,
  areaType: row.area_type ?? null,
  detail: JSON.parse(row.detail),
  posts: JSON.parse(row.posts),
  deliveries: row.deliveries ? JSON.parse(row.deliveries) : {},
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
        kind         TEXT,
        severity     TEXT,
        status       TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        expires_at   TEXT,
        serial       TEXT,
        headline     TEXT NOT NULL,
        area         TEXT,
        area_type    TEXT,
        detail       TEXT NOT NULL,
        posts        TEXT NOT NULL,
        deliveries   TEXT,
        revision     INTEGER NOT NULL,
        mirrored_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alert_status_unmirrored
        ON alert_status (mirrored_at);
    `);
    this.migrate();
  }

  // 既存の DB を作り直さずに列を足す。
  // SQLite の ADD COLUMN に IF NOT EXISTS が無いため、現在の列を見て判断する。
  private migrate(): void {
    const db = this.database();
    const existing = new Set(
      (
        db.prepare("PRAGMA table_info(alert_status)").all() as unknown as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    for (const [name, type] of [
      ["kind", "TEXT"],
      ["severity", "TEXT"],
      ["expires_at", "TEXT"],
      ["area", "TEXT"],
      ["area_type", "TEXT"],
      ["deliveries", "TEXT"],
    ]) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE alert_status ADD COLUMN ${name} ${type}`);
      }
    }
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
          key, category, kind, severity, status, published_at, updated_at,
          expires_at, serial, headline, area, area_type, detail, posts, deliveries, revision, mirrored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET
          category     = excluded.category,
          kind         = excluded.kind,
          severity     = excluded.severity,
          status       = excluded.status,
          published_at = excluded.published_at,
          updated_at   = excluded.updated_at,
          expires_at   = excluded.expires_at,
          serial       = excluded.serial,
          headline     = excluded.headline,
          area         = excluded.area,
          area_type    = excluded.area_type,
          detail       = excluded.detail,
          posts        = excluded.posts,
          deliveries   = excluded.deliveries,
          revision     = excluded.revision,
          mirrored_at  = NULL
      `)
      .run(
        record.key,
        record.category,
        record.kind,
        record.severity,
        record.status,
        record.publishedAt,
        record.updatedAt,
        record.expiresAt,
        record.serial,
        record.headline,
        record.area ? JSON.stringify(record.area) : null,
        record.areaType,
        JSON.stringify(record.detail),
        JSON.stringify(record.posts),
        JSON.stringify(record.deliveries),
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
