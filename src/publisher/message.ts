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
import {
  FOOTER,
  type Tier,
  headline,
  intensityColor,
  severityColor,
  shakingCallToAction,
  tierForIntensity,
  tierForSeverity,
  titleWithEmoji,
} from "./style.js";

// Bluesky は 300 グラフェムが上限。地域を並べると容易に超えるため、
// 収まらない分は件数で表す。
export const MAX_GRAPHEMES = 300;

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

// 発表と解除を繰り返す情報。見出しにどちらかを添える。
// 記録的短時間大雨情報や竜巻注意情報は一度きりの発表なので含めない。
const LIFECYCLE_HAZARDS: HazardType[] = [
  "weather",
  "tsunami",
  "sediment",
  "volcano",
  "flood",
];

const graphemes = (text: string): number => [...text].length;

interface ObservedGroup {
  intensity: string;
  names: string[];
}

const observedGroups = (alert: ClassifiedAlert): ObservedGroup[] => {
  const value = alert.detail.observed;
  return Array.isArray(value) ? (value as ObservedGroup[]) : [];
};

// 震度を色付きの見出しにし、観測地域をその下にぶら下げる。
// 段階ごとに固まるため、強い震度がどこに出たかを目で追える。
const observedBlock = (group: ObservedGroup, names: string[]): string => {
  const color = intensityColor(group.intensity);
  return [
    `${color ? `${color} ` : ""}震度${intensityLabel(group.intensity)}`,
    ...names.map((name) => `　${name}`),
  ].join("\n");
};

// 段階1件を全地域込みで並べたときの長さ。ブロックは空行で区切る。
const groupCost = (group: ObservedGroup): number =>
  graphemes(observedBlock(group, group.names)) + 2;

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
const observedBlocks = (groups: ObservedGroup[], budget: number): string[] => {
  const blocks: string[] = [];
  let remaining = budget;
  for (const group of groups) {
    const full = observedBlock(group, group.names);
    if (graphemes(full) <= remaining) {
      blocks.push(full);
      remaining -= graphemes(full) + 2;
      continue;
    }
    const summary = observedBlock(group, [
      `${group.names[0]} ほか${group.names.length - 1}地域`,
    ]);
    if (group.names.length > 1 && graphemes(summary) <= remaining) {
      blocks.push(summary);
      remaining -= graphemes(summary) + 2;
      continue;
    }
    break;
  }
  return blocks;
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

// 装飾の段階。地震は震度、それ以外は緊急度で決める。
const tierOf = (alert: ClassifiedAlert): Tier =>
  alert.hazard === "earthquake"
    ? tierForIntensity(detailText(alert, "maxInt") ?? "")
    : tierForSeverity(alert.severity, alert.state);

// 見出しの語。状態は記号ではなく言葉で示す。
const titleOf = (alert: ClassifiedAlert, name: string): string => {
  if (alert.hazard === "earthquake") {
    // 震度速報は Earthquake 要素を持たず発生時刻が無いため、発表時刻で代える
    const time = hhmm(detailText(alert, "originTime") ?? alert.reportedAt);
    return time === "" ? name : `${name}（${time}）`;
  }
  if (alert.state === "resolved" || alert.state === "cancelled") {
    return `${name} 解除`;
  }
  return LIFECYCLE_HAZARDS.includes(alert.hazard) ? `${name} 発表` : name;
};

// 種別ごとの本文。地域名は呼び出し側が組み立てる。
const body = (alert: ClassifiedAlert): string[] => {
  const lines: string[] = [];
  switch (alert.hazard) {
    case "earthquake": {
      // 震度速報 (VXSE51) は Earthquake 要素を持たず震源が分からない。
      // 「震源 不明」と書くより出さないほうが読みやすい。
      const place = detailText(alert, "place");
      if (!place) break;
      const magnitude = detailText(alert, "magnitude");
      const depth = detailText(alert, "depth");
      lines.push(
        [
          `震源 ${place}`,
          magnitude ? `M${magnitude}` : null,
          // 深さ0は気象庁の表記に合わせる
          depth === "0" ? "ごく浅い" : depth ? `深さ${depth}km` : null,
        ]
          .filter(Boolean)
          .join(" / "),
      );
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
  blocks: string[],
  hashtag: string,
): string =>
  [head, areas, ...blocks, hashtag, FOOTER]
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
  const tier = tierOf(first);
  const title = titleOf(first, name);
  const head = headline(tier, titleWithEmoji(tier, title, first.hazard));
  const lines = body(first);
  const hashtag = HASHTAG[first.hazard] ?? "";

  const maxInt = detailText(first, "maxInt") ?? "";
  const isEarthquake = first.hazard === "earthquake";

  // 長周期地震動階級は震度に付与される情報なので、震度の並びの後に置く。
  const lgInt = detailText(first, "maxLgInt");
  const suffix = [
    isEarthquake && lgInt && lgInt !== "0"
      ? `（長周期地震動階級 ${lgInt}）`
      : null,
    isEarthquake ? shakingCallToAction("observed", maxInt) : null,
  ].filter((part): part is string => part !== null);

  // 全国に配信するため、地域名には都道府県名を含める。
  // 気象庁の地域コードは先頭2桁が都道府県コードになっている。
  // 地震の area は震央地名で、震源の行に出るためここでは扱わない。
  const names = isEarthquake
    ? []
    : [
        ...new Set(
          alerts
            .map((a) =>
              a.area ? withPrefecture(a.area.name, a.area.code) : "",
            )
            .filter(Boolean),
        ),
      ];
  // 見出し・本文・注記・タグを除いた残りを地域名に割り当てる。
  // 解除は危険度を示す色を持たないため、地域名だけを出す。
  // 色は警報種別名 (detail.kind) から引く。alertName は洪水で
  // 「指定河川洪水予報」のような総称になり、氾濫発生などの段階が落ちるため。
  const resolved = first.state === "resolved" || first.state === "cancelled";
  const kindName = detailText(first, "kind") ?? name;
  const color = resolved
    ? ""
    : `${severityColor(first.severity, kindName, first.hazard)} `;
  const fixed = graphemes(assemble(head, "", [...lines, ...suffix], hashtag));
  const listed = areaLine(names, Math.max(0, maxGraphemes - fixed - 2));
  const areas = listed === "" ? "" : `${color}${listed}`;

  const base = assemble(head, areas, [...lines, ...suffix], hashtag);

  // 地震は震度を観測した地域を添える。
  // 震度1〜2は件数が多く全国配信では判断に寄与しないため落とす。
  const groups = observedGroups(first).filter(
    (g) => intensityRank(g.intensity) >= intensityRank(MIN_POSTED_INTENSITY),
  );
  if (groups.length === 0) return [base];

  const build = (selected: ObservedGroup[], label: string): string | null => {
    if (selected.length === 0) return null;
    // 分割したときだけ、その投稿が扱う震度の範囲を見出しに出す
    const splitHead =
      label === ""
        ? head
        : headline(
            tier,
            titleWithEmoji(tier, `${title} ${label}`, first.hazard),
          );
    const used = graphemes(
      assemble(splitHead, areas, [...lines, ...suffix], hashtag),
    );
    const observed = observedBlocks(
      selected,
      Math.max(0, maxGraphemes - used - 2),
    );
    if (observed.length === 0) return null;
    return assemble(
      splitHead,
      areas,
      [...lines, ...observed, ...suffix],
      hashtag,
    );
  };

  // 予算は、見出し・震源・本文・注記・タグを除いた残り。
  // 分割時は範囲の見出しが加わるため、その分を見込んでおく。
  const overhead = graphemes(
    assemble(
      headline(
        tier,
        titleWithEmoji(tier, `${title} 震度6強〜5弱`, first.hazard),
      ),
      areas,
      [...lines, ...suffix],
      hashtag,
    ),
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
