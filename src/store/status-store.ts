import type { AlertStatusRecord } from "../core/status.js";

// ステータスの永続化層。SQLite 実装が正で、リレーはここから派生したミラー。
export interface StatusStore {
  init(): Promise<void>;
  // 保存済みの全レコードを返す (起動時の復元用)
  load(): Promise<AlertStatusRecord[]>;
  // 保存する。内容が変わるためミラー済みの印は落とす。
  save(record: AlertStatusRecord): Promise<void>;
  // リレーへ未反映のレコードを返す
  listUnmirrored(): Promise<AlertStatusRecord[]>;
  // ミラー完了を記録する。保存済みの版が revision と一致する場合のみ印を付ける。
  markMirrored(key: string, revision: number): Promise<void>;
  close(): Promise<void>;
}
