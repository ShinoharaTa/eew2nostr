import type { AlertCategory, AlertStatus } from "../core/status.js";
import type { AlertStatusRecord } from "../core/status.js";
import { logger } from "../logger.js";
import type { StatusManager } from "./status-manager.js";

// 解除電文が存在せず、続報が来なくなるだけの種別に持たせる既定の寿命。
// updatedAt から測るため、続報 (VXSE51 → VXSE52 → VXSE53) が来れば測り直しになる。
//
// ここに載せるのは「終端に到達する経路が電文側に無い」種別だけ。
// weather / tsunami / volcano / flood / sediment / megaquake は解除電文で
// resolved になるため、時間で切ってはいけない (発表が続いている最中に
// 消えてしまう)。
export const DEFAULT_TTL_MS: Partial<Record<AlertCategory, number>> = {
  // 最終報を取りこぼしたとき用。EEW は数分で出し切る。
  eew: 10 * 60_000,
  earthquake: 60 * 60_000,
  "heavy-rain": 3 * 60 * 60_000,
};

export type SweepReason = "expired" | "ttl";

export interface SweepTarget {
  key: string;
  status: AlertStatus;
  reason: SweepReason;
  headline: string;
}

const time = (iso: string | null): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

// 終端に落とすべきレコードを選ぶ。時刻を引数で受け取る純粋関数にして、
// スケジューラを動かさずに境界を試せるようにする。
//
// - expiresAt を過ぎたもの → resolved (有効期限が切れた = もう出ていない)
// - 種別の TTL を過ぎたもの → finalized (解除されたのではなく出し切った)
//
// 有効期限は電文が明示した値なので、TTL より優先する。
export const dueForSweep = (
  records: AlertStatusRecord[],
  now: Date,
  ttl: Partial<Record<AlertCategory, number>> = DEFAULT_TTL_MS,
): SweepTarget[] => {
  const at = now.getTime();
  const targets: SweepTarget[] = [];
  for (const record of records) {
    if (record.status !== "active") continue;
    const expiresAt = time(record.expiresAt);
    if (expiresAt !== null && expiresAt <= at) {
      targets.push({
        key: record.key,
        status: "resolved",
        reason: "expired",
        headline: record.headline,
      });
      continue;
    }
    const limit = ttl[record.category];
    if (limit === undefined) continue;
    const updatedAt = time(record.updatedAt);
    if (updatedAt === null) continue;
    if (updatedAt + limit > at) continue;
    targets.push({
      key: record.key,
      status: "finalized",
      reason: "ttl",
      headline: record.headline,
    });
  }
  return targets;
};

// 発表中のまま取り残されたステータスを定期的に終端へ落とす。
//
// SNS へは配信しない。受信を止めていた間に溜まった取り残しが一斉に
// 投稿されるのを避けるため (AlertRecorder.resolveMissing と同じ方針)。
export class StatusSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private status: StatusManager,
    private ttl: Partial<Record<AlertCategory, number>> = DEFAULT_TTL_MS,
  ) {}

  async sweep(now: Date = new Date()): Promise<SweepTarget[]> {
    const targets = dueForSweep(this.status.active(), now, this.ttl);
    const updatedAt = now.toISOString();
    for (const target of targets) {
      await this.status.update(target.key, (record) => {
        record.status = target.status;
        record.updatedAt = updatedAt;
      });
    }
    if (targets.length > 0) {
      logger.info("取り残されたステータスを終端に落としました", {
        count: targets.length,
        expired: targets.filter((t) => t.reason === "expired").length,
        ttl: targets.filter((t) => t.reason === "ttl").length,
        keys: targets.map((t) => t.key).slice(0, 5),
      });
    }
    return targets;
  }

  // 起動時に1回、以降は intervalMs ごと。
  // 起動直後の1回で、停止中に溜まった分を片付ける。
  start(intervalMs: number): void {
    void this.sweep().catch((e) => {
      logger.error("ステータスのスイープに失敗しました", { err: e });
    });
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => {
        logger.error("ステータスのスイープに失敗しました", { err: e });
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
