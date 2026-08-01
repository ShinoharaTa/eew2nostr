import { classify } from "../classify/index.js";
import type { ClassifiedAlert } from "../classify/types.js";
import type { AlertStatusRecord } from "../core/status.js";
import { logger } from "../logger.js";
import type { JmaTelegram } from "../receiver/jma-feed.js";
import type { StatusManager } from "./status-manager.js";

// 分類結果を保存用のレコードに移す。
// 初回は発表時刻を publishedAt に据え、以降は updatedAt だけを進める。
const initialRecord = (alert: ClassifiedAlert): AlertStatusRecord => ({
  key: alert.key,
  category: alert.hazard,
  severity: alert.severity,
  status: alert.state,
  publishedAt: alert.reportedAt,
  updatedAt: alert.reportedAt,
  expiresAt: alert.expiresAt,
  serial: null,
  headline: alert.headline,
  area: alert.area,
  detail: alert.detail,
  posts: {},
  revision: 0,
});

const applyAlert = (
  record: AlertStatusRecord,
  alert: ClassifiedAlert,
): void => {
  record.category = alert.hazard;
  record.severity = alert.severity;
  record.status = alert.state;
  record.updatedAt = alert.reportedAt;
  record.expiresAt = alert.expiresAt;
  record.headline = alert.headline;
  record.area = alert.area;
  record.detail = alert.detail;
};

// 気象庁の電文を分類してステータスストアに記録する。
// SNS への投稿は行わない。
export class AlertRecorder {
  constructor(private status: StatusManager) {}

  async record(telegram: JmaTelegram): Promise<number> {
    const alerts = classify(telegram.type, telegram.report);
    if (alerts.length === 0) return 0;

    // 同じ電文内で同じキーが複数回現れた場合は、後ろにあるものを最終状態とする
    const latest = new Map<string, ClassifiedAlert>();
    for (const alert of alerts) latest.set(alert.key, alert);

    for (const alert of latest.values()) {
      await this.status.upsert(initialRecord(alert), (record) =>
        applyAlert(record, alert),
      );
    }
    logger.info("alerts recorded", {
      type: telegram.type,
      count: latest.size,
      keys: [...latest.keys()].slice(0, 5),
    });
    return latest.size;
  }
}
