import { format, parseISO } from "date-fns";
import {
  MAX_SPLIT_POSTS,
  MIN_POSTED_INTENSITY,
  intensityLabel,
  intensityRangeLabel,
  intensityRank,
} from "../classify/intensity.js";
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

// 段階1件を全地域込みで並べたときの長さ
const groupCost = (group: ObservedGroup): number =>
  graphemes(
    `震度${intensityLabel(group.intensity)} ${group.names.join("、")}`,
  ) + 1;

// 震度の強い順に、予算に収まるところまで詰めて投稿を切り分ける。
//
// 地震ごとに震度の分布が大きく違うため、固定の境界では偏る。
// 東日本大震災は強い震度の地域が多く、能登半島地震は弱い震度が多い。
// 段階の境界でだけ切ることで、どちらの形でも均される。
//
// 上限に達したら残りは最後の投稿にまとめ、地域名の省略で吸収する。
const packGroups = (
  groups: ObservedGroup[],
  budget: number,
): ObservedGroup[][] => {
  const posts: ObservedGroup[][] = [];
  let current: ObservedGroup[] = [];
  let used = 0;
  for (const group of groups) {
    const cost = groupCost(group);
    const isLastPost = posts.length + 1 >= MAX_SPLIT_POSTS;
    if (current.length > 0 && used + cost > budget && !isLastPost) {
      posts.push(current);
      current = [];
      used = 0;
    }
    current.push(group);
    used += cost;
  }
  if (current.length > 0) posts.push(current);
  return posts;
};

// 震度を観測した地域を強い順に並べる。震源だけでは
// どの地域が揺れたか伝わらないため添える。
// 文字数に収まらない分は地域名を件数に置き換える。
const observedLines = (groups: ObservedGroup[], budget: number): string[] => {
  const lines: string[] = [];
  let remaining = budget;
  for (const group of groups) {
    const head = `震度${intensityLabel(group.intensity)} `;
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

// 同じ電文から生まれた同種の防災イベントを投稿文にする。
// 気象警報は一次細分区域ごとにイベントが分かれるため、
// 個別に投稿すると同じ内容が地域の数だけ並んでしまう。
//
// 地震は観測地域が多く1件に収まらないことがあるため、
// 震度4以上と震度3で分けた複数の投稿になることがある。
export const formatAlertPosts = (
  alerts: ClassifiedAlert[],
  maxGraphemes: number = MAX_GRAPHEMES,
): string[] => {
  if (alerts.length === 0) return [];
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

  const base = assemble(head, areas, lines, hashtag);

  // 地震は震度を観測した地域を添える。
  // 震度1〜2は件数が多く全国配信では判断に寄与しないため落とす。
  const groups = observedGroups(first).filter(
    (g) => intensityRank(g.intensity) >= intensityRank(MIN_POSTED_INTENSITY),
  );
  if (groups.length === 0) return [base];

  const build = (selected: ObservedGroup[], label: string): string | null => {
    if (selected.length === 0) return null;
    // 分割したときだけ、その投稿が扱う震度の範囲を見出しに出す
    const title = label === "" ? head : `${head} ${label}`;
    const used = graphemes(assemble(title, areas, lines, hashtag));
    const observed = observedLines(
      selected,
      Math.max(0, maxGraphemes - used - 2),
    );
    if (observed.length === 0) return null;
    return assemble(title, areas, [...lines, "", ...observed], hashtag);
  };

  // 予算は、見出し・震源・本文・注記・タグを除いた残り。
  // 分割時は範囲の見出しが加わるため、その分を見込んでおく。
  const overhead = graphemes(
    assemble(`${head} 震度6強〜5弱`, areas, lines, hashtag),
  );
  const packed = packGroups(groups, Math.max(0, maxGraphemes - overhead - 2));

  // 1件に収まるなら範囲の見出しは付けない
  if (packed.length <= 1) {
    const single = build(groups, "");
    return single !== null ? [single] : [base];
  }

  const posts: string[] = [];
  for (const selected of packed) {
    const built = build(
      selected,
      intensityRangeLabel(selected.map((g) => g.intensity)),
    );
    if (built !== null) posts.push(built);
  }
  return posts.length > 0 ? posts : [base];
};

// 1件の投稿文にまとめる。複数に分かれる場合は先頭を返す。
export const formatAlerts = (
  alerts: ClassifiedAlert[],
  maxGraphemes: number = MAX_GRAPHEMES,
): string => formatAlertPosts(alerts, maxGraphemes)[0] ?? "";

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
