import type { JmaReport } from "../receiver/jma-xml.js";
import {
  classifyEarthquake,
  classifyEruptionFlash,
  classifyFlood,
  classifyHeavyRain,
  classifyHeavyRainBand,
  classifyMegaquake,
  classifySediment,
  classifyTornado,
  classifyTsunami,
  classifyVolcano,
  classifyWeather,
  weatherScopes,
} from "./classifiers.js";
import type { AlertKind, AlertScope, ClassifiedAlert } from "./types.js";

export * from "./types.js";

type ClassifyFn = (
  report: JmaReport,
  ctx: {
    reportedAt: string;
    headline: string;
    title: string;
    expiresAt: string | null;
    kind: AlertKind;
  },
) => ClassifiedAlert[];

// 電文種別ごとに、分類器と情報の性質を対応させる。
// 予測と実測は同じ災害種別の中に混在するため、種別コード単位で決める。
interface Handler {
  classify: ClassifyFn;
  kind: AlertKind;
  // 電文がその範囲の現況を全量で載せる種別だけが持つ。
  // 電文に載っていない発表中のレコードを終了とみなすために使う。
  scope?: (report: JmaReport) => AlertScope[];
}

const forecast = (fn: ClassifyFn): Handler => ({
  classify: fn,
  kind: "forecast",
});
const observed = (fn: ClassifyFn): Handler => ({
  classify: fn,
  kind: "observed",
});

// 扱う電文種別と分類器の対応。ここに無い種別は配信・記録の対象外。
//
// 気象警報・注意報は VPWW53 のみ採用する。VPWW54 は VPWW53 と完全に
// 同一内容の二重配信であり、R06系 (VPWW55/56/58/59/61) も並行配信のため、
// すべて処理すると同じ警報を重複して記録してしまう。
const CLASSIFIERS: Record<string, Handler> = {
  // 一次細分区域ブロックは府県予報区の全区域の現況を載せる。
  // 警報から注意報への切り替えでは警報側の解除電文が出ないため、
  // 電文に載っていない警報を終了とみなす経路を併せて持たせる。
  VPWW53: { ...forecast(classifyWeather), scope: weatherScopes },

  VXSE51: observed(classifyEarthquake), // 震度速報
  VXSE52: observed(classifyEarthquake), // 震源に関する情報
  VXSE53: observed(classifyEarthquake), // 震源・震度に関する情報
  VXSE61: observed(classifyEarthquake), // 顕著な地震の震源要素更新
  // 長周期地震動に関する観測情報。震度 (MaxInt) と
  // 長周期地震動階級 (MaxLgInt) を両方持つ。
  VXSE62: observed(classifyEarthquake),

  VYSE50: forecast(classifyMegaquake), // 南海トラフ地震臨時情報
  VYSE60: forecast(classifyMegaquake), // 北海道・三陸沖後発地震注意情報

  VTSE41: forecast(classifyTsunami), // 津波警報・注意報・予報
  VTSE51: observed(classifyTsunami), // 津波情報

  VFVO50: forecast(classifyVolcano), // 噴火警報・予報
  VFVO56: observed(classifyEruptionFlash), // 噴火速報
  // VFVO52 (噴火に関する火山観測報) は対象外。
  // 対象火山ブロックを持たず、桜島の日常的な噴火が大半を占めるため。
  // 噴火警戒レベルの変化は VFVO50 で記録される。

  VXWW50: forecast(classifySediment), // 土砂災害警戒情報

  VPHW50: forecast(classifyTornado), // 竜巻注意情報
  VPHW51: forecast(classifyTornado), // 竜巻注意情報 (目撃情報付き)

  VPOA50: observed(classifyHeavyRain), // 記録的短時間大雨情報

  // 府県気象防災速報。線状降水帯の発生が構造化されて入っている。
  // 記録的短時間大雨情報と並ぶ大雨災害の直前シグナル。
  VPBS50: observed(classifyHeavyRainBand),
};

// 種別コードの下2桁が発表元ごとに変わる電文。範囲で受ける。
// 指定河川洪水予報は水系ごとにコードが振られ、VXKO(ii=50-89) の40通りある。
// 個別に列挙すると、実データで観測できていない水系の氾濫警戒を
// 黙って取りこぼす (気象庁「気象庁防災情報XML一覧表」表1.1)。
const RANGE_CLASSIFIERS: {
  prefix: string;
  range: [number, number];
  handler: Handler;
}[] = [{ prefix: "VXKO", range: [50, 89], handler: forecast(classifyFlood) }];

const rangeHandler = (type: string): Handler | null => {
  for (const { prefix, range, handler } of RANGE_CLASSIFIERS) {
    if (!type.startsWith(prefix) || type.length !== prefix.length + 2) continue;
    const suffix = Number(type.slice(prefix.length));
    if (Number.isInteger(suffix) && suffix >= range[0] && suffix <= range[1])
      return handler;
  }
  return null;
};

const handlerFor = (type: string): Handler | null =>
  CLASSIFIERS[type] ?? rangeHandler(type);

export const isSupported = (type: string | null): boolean =>
  type !== null && handlerFor(type) !== null;

export const supportedTypes = (): string[] => [
  ...Object.keys(CLASSIFIERS),
  ...RANGE_CLASSIFIERS.map(
    ({ prefix, range }) => `${prefix}${range[0]}-${range[1]}`,
  ),
];

// 電文1通から0件以上の防災イベントを取り出す。
// 気象警報は (一次細分区域 × 警報種別) の数だけ生まれる。
export const classify = (
  type: string | null,
  report: JmaReport,
): ClassifiedAlert[] => {
  if (type === null) return [];
  const handler = handlerFor(type);
  if (!handler) return [];
  return handler.classify(report, {
    reportedAt: report.head.reportDateTime,
    headline: report.head.headline ?? report.head.title,
    title: report.head.title,
    expiresAt: report.head.validDateTime,
    kind: handler.kind,
  });
};

// 電文が全量で載せている範囲を返す。持たない種別では空。
// 呼び出し側は、返った範囲のうち電文に載っていないレコードを終了として扱う。
export const scopes = (
  type: string | null,
  report: JmaReport,
): AlertScope[] => {
  if (type === null) return [];
  return handlerFor(type)?.scope?.(report) ?? [];
};
