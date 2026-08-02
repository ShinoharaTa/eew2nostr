import { format, parseISO } from "date-fns";
import type { ClassifiedAlert, HazardType } from "../classify/types.js";

// Bluesky は 300 グラフェムが上限。地域を並べると容易に超えるため、
// 収まらない分は件数で表す。
export const MAX_GRAPHEMES = 300;

const FOOTER = "※このシステムは試験運用中です。突然終了する場合があります。";

const HASHTAG: Record<HazardType, string> = {
  eew: "#eew",
  earthquake: "#地震",
  tsunami: "#津波",
  volcano: "#噴火",
  weather: "#気象警報",
  sediment: "#土砂災害",
  flood: "#洪水",
  tornado: "#竜巻",
  "heavy-rain": "#大雨",
};

const graphemes = (text: string): number => [...text].length;

const hhmm = (iso: string | null | undefined): string => {
  if (!iso) return "";
  try {
    return format(parseISO(iso), "HH:mm");
  } catch {
    return "";
  }
};

const detailText = (alert: ClassifiedAlert, key: string): string | null => {
  const value = alert.detail[key];
  return typeof value === "string" && value !== "" ? value : null;
};

// 見出し。解除は状態が伝わるよう語尾を変える。
const heading = (alert: ClassifiedAlert, name: string): string =>
  alert.state === "resolved" ? `【${name} 解除】` : `【${name}】`;

const alertName = (alert: ClassifiedAlert): string => {
  switch (alert.hazard) {
    case "earthquake":
      return "地震情報";
    case "tsunami":
      return (detailText(alert, "kind") ?? "津波情報").replace("解除", "");
    case "volcano":
      return "噴火警報";
    case "weather":
      return detailText(alert, "kind") ?? "気象警報";
    case "sediment":
      return "土砂災害警戒情報";
    case "flood":
      return "指定河川洪水予報";
    case "tornado":
      return "竜巻注意情報";
    case "heavy-rain":
      return "記録的短時間大雨情報";
    default:
      return "防災情報";
  }
};

// 種別ごとの本文。地域名は呼び出し側が組み立てる。
const body = (alert: ClassifiedAlert): string[] => {
  const lines: string[] = [];
  switch (alert.hazard) {
    case "earthquake": {
      const maxInt = detailText(alert, "maxInt");
      const magnitude = detailText(alert, "magnitude");
      if (maxInt)
        lines.push(`最大震度 ${maxInt}${magnitude ? `（M${magnitude}）` : ""}`);
      const lg = detailText(alert, "maxLgInt");
      if (lg && lg !== "0") lines.push(`長周期地震動階級 ${lg}`);
      break;
    }
    case "volcano": {
      const kind = detailText(alert, "kind");
      const condition = detailText(alert, "condition");
      if (kind) lines.push(condition ? `${kind}に${condition}` : kind);
      break;
    }
    case "weather": {
      const attention = detailText(alert, "attention");
      if (attention) lines.push(attention);
      break;
    }
    case "flood": {
      const text = detailText(alert, "text");
      if (text) lines.push(text);
      break;
    }
    case "heavy-rain": {
      const text = detailText(alert, "text");
      if (text) lines.push(text.replace(/\n+/g, " ").trim());
      break;
    }
    case "tornado": {
      const until = hhmm(alert.expiresAt);
      if (until) lines.push(`${until}まで有効`);
      break;
    }
  }
  return lines;
};

// 地域名を並べる。上限を超える場合は件数に置き換える。
const areaLine = (names: string[], budget: number): string => {
  if (names.length === 0) return "";
  const joined = names.join("、");
  if (graphemes(joined) <= budget) return joined;
  const summary = `${names[0]} ほか${names.length - 1}地域`;
  return graphemes(summary) <= budget ? summary : `${names.length}地域`;
};

const assemble = (
  head: string,
  areas: string,
  lines: string[],
  hashtag: string,
): string =>
  [head + (areas ? `\n${areas}` : ""), lines.join("\n"), FOOTER, hashtag]
    .filter((part) => part !== "")
    .join("\n\n");

// 同じ電文から生まれた同種の防災イベントを1件の投稿にまとめる。
// 気象警報は一次細分区域ごとにイベントが分かれるため、
// 個別に投稿すると同じ内容が地域の数だけ並んでしまう。
export const formatAlerts = (
  alerts: ClassifiedAlert[],
  maxGraphemes: number = MAX_GRAPHEMES,
): string => {
  if (alerts.length === 0) return "";
  const first = alerts[0];
  const name = alertName(first);
  const head =
    first.hazard === "earthquake"
      ? `${heading(first, name)}${hhmm(detailText(first, "originTime"))}`
      : heading(first, name);
  const lines = body(first);
  const hashtag = HASHTAG[first.hazard] ?? "";

  // 一次細分区域は「北西部」のように単独では通じないため府県名を補う
  const prefecture = detailText(first, "prefecture");
  const names = [
    ...new Set(
      alerts
        .map((a) => a.area?.name ?? "")
        .filter(Boolean)
        .map((name) =>
          prefecture && !name.startsWith(prefecture)
            ? `${prefecture}${name}`
            : name,
        ),
    ),
  ];
  // 見出し・本文・注記・タグを除いた残りを地域名に割り当てる
  const fixed = graphemes(assemble(head, "", lines, hashtag));
  return assemble(
    head,
    areaLine(names, Math.max(0, maxGraphemes - fixed)),
    lines,
    hashtag,
  );
};

export const formatAlert = (
  alert: ClassifiedAlert,
  maxGraphemes: number = MAX_GRAPHEMES,
): string => formatAlerts([alert], maxGraphemes);

// 1通の電文から生まれたイベントを、投稿単位にまとめる。
// 種別・状態・緊急度が同じものを1件にする。
export const groupForPosting = (
  alerts: ClassifiedAlert[],
): ClassifiedAlert[][] => {
  const groups = new Map<string, ClassifiedAlert[]>();
  for (const alert of alerts) {
    const key = `${alert.hazard}|${alert.state}|${alert.severity}|${alertName(alert)}`;
    const group = groups.get(key);
    if (group) group.push(alert);
    else groups.set(key, [alert]);
  }
  return [...groups.values()];
};
