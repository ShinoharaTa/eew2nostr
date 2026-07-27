import { SerialQueue } from "../core/serial-queue.js";
import type { AlertStatusRecord } from "../core/status.js";
import { logger } from "../logger.js";
import type { StatusMirror } from "./relay-mirror.js";
import type { StatusStore } from "./status-store.js";

// 防災イベントの状態を保持する。
// 変更は同期的にメモリ上のレコードへ適用してから SQLite に保存し、
// その後リレーへ非同期にミラーする。
export class StatusManager {
  private records = new Map<string, AlertStatusRecord>();
  private mirrorQueue = new SerialQueue();

  constructor(
    private store: StatusStore,
    private mirror: StatusMirror,
  ) {}

  async init(): Promise<void> {
    for (const record of await this.store.load()) {
      this.records.set(record.key, record);
    }
    logger.info(`status restored: ${this.records.size} records`);
    const unmirrored = await this.store.listUnmirrored();
    if (unmirrored.length > 0) {
      logger.info(`re-mirroring ${unmirrored.length} records to relay`);
      for (const record of unmirrored) this.enqueueMirror(record);
    }
  }

  get(key: string): AlertStatusRecord | undefined {
    return this.records.get(key);
  }

  // 既存レコードがあればそれを、無ければ initial を採用して mutate を適用する
  async upsert(
    initial: AlertStatusRecord,
    mutate: (record: AlertStatusRecord) => void,
  ): Promise<AlertStatusRecord> {
    let record = this.records.get(initial.key);
    if (!record) {
      record = initial;
      this.records.set(record.key, record);
    }
    mutate(record);
    await this.persist(record);
    return record;
  }

  // 既存レコードを変更する。存在しない場合は何もしない。
  async update(
    key: string,
    mutate: (record: AlertStatusRecord) => void,
  ): Promise<void> {
    const record = this.records.get(key);
    if (!record) {
      logger.warn(`status record not found: ${key}`);
      return;
    }
    mutate(record);
    await this.persist(record);
  }

  // 積まれたミラーの完了を待つ(テスト・シャットダウン用)
  async flush(): Promise<void> {
    await this.mirrorQueue.idle();
  }

  private async persist(record: AlertStatusRecord): Promise<void> {
    record.revision += 1;
    await this.store.save(record);
    this.enqueueMirror(record);
  }

  // ミラーは本体の投稿を止めないよう非同期に行う。
  // 失敗しても SQLite 側は未ミラーのまま残るため、次回起動時に再送される。
  private enqueueMirror(record: AlertStatusRecord): void {
    const snapshot: AlertStatusRecord = structuredClone(record);
    this.mirrorQueue.push(async () => {
      try {
        await this.mirror.mirror(snapshot);
        await this.store.markMirrored(snapshot.key, snapshot.revision);
      } catch (e) {
        logger.error("status mirror failed", { key: snapshot.key, err: e });
      }
    });
  }
}
