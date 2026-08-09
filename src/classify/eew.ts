import type { EEWReport } from "../core/parser.js";
import {
  UNKNOWN_INTENSITY,
  forecastIntensityLabel,
  forecastIntensityValue,
  intensityRank,
} from "./intensity.js";
import type { ClassifiedAlert, Severity } from "./types.js";

// 緊急地震速報のステータスキー。取消報が同じ事象を指せるよう eventId で揃える。
export const eewStatusKey = (eventId: string): string => `eew:${eventId}`;

// 予想震度で緊急度を決める。実測の地震情報と同じ基準に揃える。
const eewSeverity = (report: EEWReport): Severity => {
  const value = forecastIntensityValue(report.forecastFrom, report.forecast);
  if (value === UNKNOWN_INTENSITY) {
    // 震度が決まらなくても、警報なら予想最大震度5弱以上の事象ではある
    return report.isWarning ? "warning" : "info";
  }
  const rank = intensityRank(value);
  if (rank >= intensityRank("6-")) return "emergency";
  if (rank >= intensityRank("5-")) return "warning";
  return "info";
};

// dmdata から受けた緊急地震速報を、気象庁フィード由来の情報と同じ
// ClassifiedAlert に落とす。これにより記録・ルーティング・配信の
// 経路を1本にできる。
export const eewAlert = (report: EEWReport): ClassifiedAlert => ({
  key: eewStatusKey(report.id),
  hazard: "eew",
  kind: "forecast",
  severity: eewSeverity(report),
  state: report.isLast ? "finalized" : "active",
  headline: `${report.place} ${forecastIntensityLabel(report.forecastFrom, report.forecast)}（M${report.magnitude}）`,
  reportedAt: report.reportTime.toISOString(),
  expiresAt: null,
  area: { name: report.place, code: "" },
  areaType: "震央地名",
  detail: {
    isWarning: report.isWarning,
    serial: report.serial,
    isLast: report.isLast,
    forecastFrom: report.forecastFrom,
    forecast: report.forecast,
    forecastLg: report.forecastLg,
    magnitude: report.magnitude,
    depth: Number.isFinite(report.depth) ? String(report.depth) : null,
    place: report.place,
    latitude: report.latitude,
    longitude: report.longitude,
    originTime: report.originTime?.toISOString() ?? null,
  },
});

// 取消報。取り消された事実だけを持つ。
export const eewCancelAlert = (id: string): ClassifiedAlert => ({
  key: eewStatusKey(id),
  hazard: "eew",
  kind: "forecast",
  severity: "info",
  state: "cancelled",
  headline: "緊急地震速報 取消",
  reportedAt: new Date().toISOString(),
  expiresAt: null,
  area: null,
  areaType: "震央地名",
  detail: {},
});
