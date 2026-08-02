import type { DatabaseSync } from "node:sqlite";

// 再起動をまたいで「どこまで処理したか」を保つ。
// これが無いと、起動のたびにフィード全件を既読化するため、
// 停止していた間に発表された電文が黙って捨てられる。
export interface FeedCursor {
  seen: string[];
  updatedAt: string;
}

export interface FeedCursorStore {
  load(feed: string): Promise<FeedCursor | null>;
  save(feed: string, seen: string[]): Promise<void>;
}

interface Row {
  seen: string;
  updated_at: string;
}

export class SqliteFeedCursorStore implements FeedCursorStore {
  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feed_cursor (
        feed       TEXT PRIMARY KEY,
        seen       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async load(feed: string): Promise<FeedCursor | null> {
    const row = this.db
      .prepare("SELECT seen, updated_at FROM feed_cursor WHERE feed = ?")
      .get(feed) as unknown as Row | undefined;
    if (!row) return null;
    try {
      return { seen: JSON.parse(row.seen), updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  async save(feed: string, seen: string[]): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO feed_cursor (feed, seen, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(feed) DO UPDATE SET
          seen = excluded.seen,
          updated_at = excluded.updated_at
      `)
      .run(feed, JSON.stringify(seen), new Date().toISOString());
  }
}
