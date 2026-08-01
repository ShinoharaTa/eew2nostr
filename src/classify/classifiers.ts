import type { JmaReport } from "../receiver/jma-xml.js";
import {
  levelFromName,
  severityFromName,
  severityFromTsunamiKind,
  severityFromVolcanoLevel,
} from "./severity.js";
import type { AlertState, ClassifiedAlert, Severity } from "./types.js";
import { area, asArray, node, text } from "./xml-value.js";

interface Context {
  reportedAt: string;
  headline: string;
  // 電文の見出し (Head/Title)。種別名や警戒レベルが入ることがある。
  title: string;
  // 有効期限 (ValidDateTime)。無い電文では null。
  expiresAt: string | null;
}

// その地域に警報が無いことを示す電文。記録も配信もしない。
const isNothing = (name: string | null, status: string | null): boolean =>
  name === null ||
  name === "" ||
  name === "なし" ||
  status === "なし" ||
  (status?.includes("警報・注意報はなし") ?? false);

const stateFromStatus = (status: string | null): AlertState =>
  status?.includes("解除") ? "resolved" : "active";

// 気象警報・注意報 (VPWW53)。
// 電文は府県 / 一次細分区域 / 市町村まとめ / 市町村 の4階層を含むため、
// 決定した粒度である一次細分区域だけを採る。
export const classifyWeather = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const warnings = asArray(report.body.Warning).filter(
    (w) => text(w["@type"])?.includes("一次細分区域") ?? false,
  );
  const alerts: ClassifiedAlert[] = [];
  for (const warning of warnings) {
    for (const item of asArray(warning.Item)) {
      const target = area(item.Area);
      if (!target) continue;
      for (const kind of asArray(item.Kind)) {
        const name = text(kind.Name);
        const status = text(kind.Status);
        if (isNothing(name, status)) continue;
        const code = text(kind.Code) ?? name ?? "";
        alerts.push({
          key: `weather:${target.code}:${code}`,
          hazard: "weather",
          severity: severityFromName(name ?? ""),
          state: stateFromStatus(status),
          headline: `${target.name}に${name}`,
          reportedAt: ctx.reportedAt,
          expiresAt: ctx.expiresAt,
          area: target,
          detail: {
            kind: name,
            kindCode: code,
            status,
            attention: text(node(kind.Attention)?.Note),
          },
        });
      }
    }
  }
  return alerts;
};

// 震度速報・震源震度情報など、実測の地震情報 (VXSE5x)。
// 同じ地震の続報は同じ eventId になるため、キーもそれに揃える。
export const classifyEarthquake = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const eventId = report.head.eventId;
  if (!eventId) return [];
  const earthquake = node(report.body.Earthquake);
  const hypocenter = area(node(node(earthquake?.Hypocenter)?.Area));
  const observation = asArray(node(report.body.Intensity)?.Observation)[0];
  const maxInt = text(observation?.MaxInt);
  return [
    {
      key: `earthquake:${eventId}`,
      hazard: "earthquake",
      severity: severityFromIntensity(maxInt),
      state: "active",
      headline: ctx.headline,
      reportedAt: ctx.reportedAt,
      expiresAt: ctx.expiresAt,
      area: hypocenter,
      detail: {
        maxInt,
        magnitude: text(earthquake?.Magnitude),
        originTime: text(earthquake?.OriginTime),
        place: hypocenter?.name ?? null,
      },
    },
  ];
};

// 実測震度。5弱以上で被害が生じうるため段階的に上げる。
const severityFromIntensity = (maxInt: string | null): Severity => {
  if (!maxInt) return "info";
  if (["6-", "6+", "7"].includes(maxInt)) return "emergency";
  if (["5-", "5+"].includes(maxInt)) return "warning";
  return "info";
};

// 津波警報・注意報 (VTSE41 / VTSE51)。津波予報区ごとに1件。
export const classifyTsunami = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const forecast = node(node(report.body.Tsunami)?.Forecast);
  const alerts: ClassifiedAlert[] = [];
  for (const item of asArray(forecast?.Item)) {
    const target = area(item.Area);
    const category = node(item.Category);
    const kind = text(node(category?.Kind)?.Name);
    if (!target || !kind) continue;
    alerts.push({
      key: `tsunami:${target.code}`,
      hazard: "tsunami",
      severity: severityFromTsunamiKind(kind),
      state: kind.includes("解除") ? "resolved" : "active",
      headline: `${target.name}に${kind}`,
      reportedAt: ctx.reportedAt,
      expiresAt: ctx.expiresAt,
      area: target,
      detail: {
        kind,
        lastKind: text(node(category?.LastKind)?.Name),
        eventId: report.head.eventId,
      },
    });
  }
  return alerts;
};

// 噴火警報・予報 (VFVO50) と火山観測報。火山ごとに1件。
export const classifyVolcano = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const alerts: ClassifiedAlert[] = [];
  for (const info of asArray(report.body.VolcanoInfo)) {
    // 対象火山を示すブロックだけを採る (地域ごとの補足ブロックは除く)
    if (!(text(info["@type"])?.includes("対象火山") ?? false)) continue;
    for (const item of asArray(info.Item)) {
      const kind = node(item.Kind);
      const name = text(kind?.Name);
      if (!name) continue;
      const target = area(node(node(item.Areas)?.Area));
      if (!target) continue;
      const level = levelFromName(name);
      const condition = text(kind?.Condition);
      alerts.push({
        key: `volcano:${target.code}`,
        hazard: "volcano",
        severity: severityFromVolcanoLevel(level),
        state: level === 1 || name.includes("解除") ? "resolved" : "active",
        headline: `${target.name} ${name}`,
        reportedAt: ctx.reportedAt,
        expiresAt: ctx.expiresAt,
        area: target,
        detail: {
          kind: name,
          level,
          condition,
          lastKind: text(node(item.LastKind)?.Name),
        },
      });
    }
  }
  return alerts;
};

// 土砂災害警戒情報 (VXWW50)。警戒レベル4相当。市町村細分ごとに1件。
export const classifySediment = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const alerts: ClassifiedAlert[] = [];
  for (const warning of asArray(report.body.Warning)) {
    for (const item of asArray(warning.Item)) {
      const kind = node(item.Kind);
      const name = text(kind?.Name);
      const status = text(kind?.Status);
      if (isNothing(name, status)) continue;
      const target = area(item.Area);
      if (!target) continue;
      const state = stateFromStatus(status);
      // Kind.Name は「警戒」など単体では意味が通らないため、
      // 種別名は電文の見出し (例: 宮城県レベル４土砂災害危険警報) から採る
      const level = levelFromName(ctx.title);
      alerts.push({
        key: `sediment:${target.code}`,
        hazard: "sediment",
        // 土砂災害警戒情報は発表そのものが警戒レベル4相当
        severity:
          state === "resolved"
            ? "info"
            : level !== null
              ? severityFromName(ctx.title)
              : "warning",
        state,
        headline:
          state === "resolved"
            ? `${target.name}の土砂災害警戒情報を解除`
            : `${target.name}に土砂災害警戒情報`,
        reportedAt: ctx.reportedAt,
        expiresAt: ctx.expiresAt,
        area: target,
        detail: {
          kind: name,
          level,
          status,
          title: ctx.title,
          prefecture: area(report.body.TargetArea),
        },
      });
    }
  }
  return alerts;
};

// 指定河川洪水予報 (VXKO*)。河川ごとに1件。
// Kind の構造が種別ごとに揺れるため、河川を指す Areas を持つ項目だけを採る。
export const classifyFlood = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const alerts: ClassifiedAlert[] = [];
  const resolved = ctx.headline.includes("解除");
  for (const warning of asArray(report.body.Warning)) {
    for (const item of asArray(warning.Item)) {
      const areas = node(item.Areas);
      if (text(areas?.["@codeType"]) !== "河川") continue;
      const target = area(node(areas?.Area));
      if (!target) continue;
      const kind = node(item.Kind);
      const name =
        text(kind?.Name) ?? text(node(kind?.Property)?.Type) ?? "洪水予報";
      alerts.push({
        key: `flood:${target.code}`,
        hazard: "flood",
        severity: resolved ? "info" : severityFromFlood(ctx.headline),
        state: resolved ? "resolved" : "active",
        headline: ctx.headline,
        reportedAt: ctx.reportedAt,
        expiresAt: ctx.expiresAt,
        area: target,
        detail: {
          kind: name,
          river: target.name,
          text: text(node(kind?.Property)?.Text),
        },
      });
    }
  }
  return alerts;
};

// 氾濫危険情報が警戒レベル4相当、氾濫警戒情報が3相当。
const severityFromFlood = (headline: string): Severity => {
  if (headline.includes("氾濫発生")) return "emergency";
  if (headline.includes("氾濫危険")) return "warning";
  return "advisory";
};

// 竜巻注意情報 (VPHW50 / VPHW51)。
// 解除電文が無く ValidDateTime (通常1時間程度) で失効するため、
// state は常に active とし、失効は expiresAt で判断させる。
export const classifyTornado = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const warnings = asArray(report.body.Warning).filter(
    (w) => text(w["@type"])?.includes("一次細分区域") ?? false,
  );
  const alerts: ClassifiedAlert[] = [];
  for (const warning of warnings) {
    for (const item of asArray(warning.Item)) {
      const kind = node(item.Kind);
      const name = text(kind?.Name);
      const status = text(kind?.Status);
      if (isNothing(name, status)) continue;
      const target = area(item.Area);
      if (!target) continue;
      alerts.push({
        key: `tornado:${target.code}`,
        hazard: "tornado",
        severity: "advisory",
        state: "active",
        headline: `${target.name}に竜巻注意情報`,
        reportedAt: ctx.reportedAt,
        expiresAt: ctx.expiresAt,
        area: target,
        detail: { kind: name, status, text: ctx.headline },
      });
    }
  }
  return alerts;
};

// 記録的短時間大雨情報 (VPOA50)。数年に一度の大雨で災害発生の危険が高い。
// 解除の概念が無い単発情報のため state は active とする。
export const classifyHeavyRain = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const alerts: ClassifiedAlert[] = [];
  for (const warning of asArray(report.body.Warning)) {
    for (const item of asArray(warning.Item)) {
      const target = area(item.Area);
      if (!target) continue;
      alerts.push({
        // 同じ地域でも発表ごとに別の事象なので eventId でキーを分ける
        key: `heavy-rain:${report.head.eventId ?? target.code}`,
        hazard: "heavy-rain",
        severity: "warning",
        state: "active",
        headline: ctx.headline,
        reportedAt: ctx.reportedAt,
        expiresAt: ctx.expiresAt,
        area: target,
        detail: { kind: text(node(item.Kind)?.Name), text: ctx.headline },
      });
    }
  }
  return alerts;
};
