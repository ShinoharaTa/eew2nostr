import { classify } from "../classify/index.js";
import type { ClassifiedAlert } from "../classify/types.js";
import type { AlertStatusRecord } from "../core/status.js";
import { logger } from "../logger.js";
import type { Delivery } from "../publisher/delivery.js";
import type { JmaTelegram } from "../receiver/jma-feed.js";
import type { Router } from "../routing/router.js";
import type { StatusManager } from "./status-manager.js";

// 分類結果を保存用のレコードに移す。
// 初回は発表時刻を publishedAt に据え、以降は updatedAt だけを進める。
const initialRecord = (alert: ClassifiedAlert): AlertStatusRecord => ({
  key: alert.key,
  category: alert.hazard,
  kind: alert.kind,
  severity: alert.severity,
  status: alert.state,
  publishedAt: alert.reportedAt,
  updatedAt: alert.reportedAt,
  expiresAt: alert.expiresAt,
  serial: null,
  headline: alert.headline,
  area: alert.area,
  areaType: alert.areaType,
  detail: alert.detail,
  posts: {},
  deliveries: {},
  lastPostText: null,
  revision: 0,
});

const applyAlert = (
  record: AlertStatusRecord,
  alert: ClassifiedAlert,
): void => {
  record.category = alert.hazard;
  record.kind = alert.kind;
  record.severity = alert.severity;
  record.status = alert.state;
  record.updatedAt = alert.reportedAt;
  record.expiresAt = alert.expiresAt;
  record.headline = alert.headline;
  record.area = alert.area;
  record.areaType = alert.areaType;
  record.detail = alert.detail;
};

// 気象庁の電文を分類してステータスストアに記録する。
// SNS への投稿は行わない。
export class AlertRecorder {
  constructor(
    private status: StatusManager,
    // 配信先の判定。投稿はまだ行わず、どこへ流れるはずかをログに残す。
    private router?: Router,
    // 配信層。未指定なら記録だけ行う。
    private delivery?: Delivery,
  ) {}

  async record(telegram: JmaTelegram): Promise<number> {
    const alerts = classify(telegram.type, telegram.report);
    if (alerts.length === 0) return 0;
    const count = await this.recordAlerts(alerts);
    logger.info("alerts recorded", {
      type: telegram.type,
      count,
      keys: alerts.map((a) => a.key).slice(0, 5),
    });
    return count;
  }

  // 分類済みのイベントを記録して配信する。
  // 緊急地震速報のように気象庁フィード以外から来る情報もここに合流する。
  async recordAlerts(alerts: ClassifiedAlert[]): Promise<number> {
    // 同じ電文内で同じキーが複数回現れた場合は、後ろにあるものを最終状態とする
    const latest = new Map<string, ClassifiedAlert>();
    for (const alert of alerts) latest.set(alert.key, alert);

    for (const alert of latest.values()) {
      await this.status.upsert(initialRecord(alert), (record) =>
        applyAlert(record, alert),
      );
      this.logRouting(alert);
    }
    // 記録を終えてから配信する。投稿が全滅しても記録は残る。
    // 配信判断は直前に記録したレコード (前回の投稿文) を参照する。
    await this.delivery?.deliver([...latest.values()]);
    return latest.size;
  }

  // 配信先を判定してログに残す。鍵が未設定のアカウントは
  // 「設定上は対象だが投稿できない」ことが分かるようにする。
  private logRouting(alert: ClassifiedAlert): void {
    if (!this.router) return;
    const target = {
      hazard: alert.hazard,
      kind: alert.kind,
      severity: alert.severity,
      state: alert.state,
    };
    const routed = this.router.route(target);
    if (routed.length === 0) return;
    const deliverable = this.router.deliverable(target).map((a) => a.key);
    logger.info("alert routed", {
      key: alert.key,
      severity: alert.severity,
      routed,
      deliverable,
      pending: routed.filter((key) => !deliverable.includes(key)),
    });
  }
}
