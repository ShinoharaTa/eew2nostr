import { format, parseISO } from "date-fns";
import { withPrefecture } from "../classify/prefecture.js";
import type { ClassifiedAlert, HazardType } from "../classify/types.js";

// Bluesky は 300 グラフェムが上限。地域を並べると容易に超えるため、
// 収まらない分は件数で表す。
export const MAX_GRAPHEMES = 300;

// 言語判定の保険。ひらがなとカタカナを混ぜておくと、
// 漢字が主体の防災情報でも日本語と推定されやすい。
const FOOTER = "※テスト運用中です。";

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

interface ObservedGroup {
  intensity: string;
  names: string[];
}

const observedGroups = (alert: ClassifiedAlert): ObservedGroup[] => {
  const value = alert.detail.observed;
  return Array.isArray(value) ? (value as ObservedGroup[]) : [];
};

// 震度を観測した地域を強い順に並べる。震源だけでは
// どの地域が揺れたか伝わらないため添える。
// 文字数に収まらない分は地域名を件数に置き換える。
const observedLines = (groups: ObservedGroup[], budget: number): string[] => {
  const lines: string[] = [];
  let remaining = budget;
  for (const group of groups) {
    const head = `震度${group.intensity} `;
    const full = head + group.names.join("、");
    if (graphemes(full) <= remaining) {
      lines.push(full);
      remaining -= graphemes(full) + 1;
      continue;
    }
    const summary = `${head}${group.names[0]} ほか${group.names.length - 1}地域`;
    if (group.names.length > 1 && graphemes(summary) <= remaining) {
      lines.push(summary);
      remaining -= graphemes(summary) + 1;
      continue;
    }
    break;
  }
  return lines;
};

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
      // 電文には府県しか構造化されておらず、地点と雨量は見出し文にしかない。
      // 定型文の解析は電文の文面変更で壊れるため、気象庁の発表文をそのまま引く。
      const text = detailText(alert, "text");
      if (text) lines.push(text.replace(/\n+/g, "\n").trim());
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
  // 震度速報は Earthquake 要素を持たず発生時刻が無いため、発表時刻で代える
  const head =
    first.hazard === "earthquake"
      ? `${heading(first, name)}${hhmm(detailText(first, "originTime") ?? first.reportedAt)}`
      : heading(first, name);
  const lines = body(first);
  const hashtag = HASHTAG[first.hazard] ?? "";

  // 全国に配信するため、地域名には都道府県名を含める。
  // 気象庁の地域コードは先頭2桁が都道府県コードになっている。
  const names = [
    ...new Set(
      alerts
        .map((a) => (a.area ? withPrefecture(a.area.name, a.area.code) : ""))
        .filter(Boolean),
    ),
  ];
  // 見出し・本文・注記・タグを除いた残りを地域名に割り当てる
  const fixed = graphemes(assemble(head, "", lines, hashtag));
  const areas = areaLine(names, Math.max(0, maxGraphemes - fixed));

  // 地震は震度を観測した地域を添える。残りの文字数に収まる分だけ出す。
  const groups = observedGroups(first);
  if (groups.length === 0) return assemble(head, areas, lines, hashtag);
  const used = graphemes(assemble(head, areas, lines, hashtag));
  const observed = observedLines(groups, Math.max(0, maxGraphemes - used - 2));
  return assemble(
    head,
    areas,
    [...lines, ...(observed.length ? [""] : []), ...observed],
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
