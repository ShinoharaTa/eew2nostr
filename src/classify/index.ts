import type { JmaReport } from "../receiver/jma-xml.js";
import {
  classifyEarthquake,
  classifyHeavyRain,
  classifyFlood,
  classifySediment,
  classifyTsunami,
  classifyTornado,
  classifyVolcano,
  classifyWeather,
} from "./classifiers.js";
import type { ClassifiedAlert } from "./types.js";

export * from "./types.js";

type ClassifyFn = (
  report: JmaReport,
  ctx: {
    reportedAt: string;
    headline: string;
    title: string;
    expiresAt: string | null;
  },
) => ClassifiedAlert[];

// 扱う電文種別と分類器の対応。ここに無い種別は配信・記録の対象外。
//
// 気象警報・注意報は VPWW53 のみ採用する。VPWW54 は VPWW53 と完全に
// 同一内容の二重配信であり、R06系 (VPWW55/56/58/59/61) も並行配信のため、
// すべて処理すると同じ警報を重複して記録してしまう。
const CLASSIFIERS: Record<string, ClassifyFn> = {
  VPWW53: classifyWeather,

  VXSE51: classifyEarthquake, // 震度速報
  VXSE52: classifyEarthquake, // 震源に関する情報
  VXSE53: classifyEarthquake, // 震源・震度に関する情報
  VXSE61: classifyEarthquake, // 顕著な地震の震源要素更新
  // VXSE62 (長周期地震動に関する観測情報) は対象外。
  // MaxInt に入るのが震度ではなく長周期地震動階級 (1〜4) のため、
  // 震度スケールで緊急度を判定すると階級4を震度7と誤認する。
  // 地震そのものは VXSE51 / VXSE53 で記録される。

  VTSE41: classifyTsunami, // 津波警報・注意報・予報
  VTSE51: classifyTsunami, // 津波情報

  VFVO50: classifyVolcano, // 噴火警報・予報
  // VFVO52 (噴火に関する火山観測報) は対象外。
  // 対象火山ブロックを持たず、桜島の日常的な噴火が大半を占めるため。
  // 噴火警戒レベルの変化は VFVO50 で記録される。

  VXWW50: classifySediment, // 土砂災害警戒情報

  VPHW50: classifyTornado, // 竜巻注意情報
  VPHW51: classifyTornado, // 竜巻注意情報 (目撃情報付き)

  VPOA50: classifyHeavyRain, // 記録的短時間大雨情報

  VXKO50: classifyFlood,
  VXKO53: classifyFlood,
  VXKO54: classifyFlood,
  VXKO57: classifyFlood,
  VXKO70: classifyFlood,
};

export const isSupported = (type: string | null): boolean =>
  type !== null && type in CLASSIFIERS;

export const supportedTypes = (): string[] => Object.keys(CLASSIFIERS);

// 電文1通から0件以上の防災イベントを取り出す。
// 気象警報は (一次細分区域 × 警報種別) の数だけ生まれる。
export const classify = (
  type: string | null,
  report: JmaReport,
): ClassifiedAlert[] => {
  if (type === null) return [];
  const classifier = CLASSIFIERS[type];
  if (!classifier) return [];
  return classifier(report, {
    reportedAt: report.head.reportDateTime,
    headline: report.head.headline ?? report.head.title,
    title: report.head.title,
    expiresAt: report.head.validDateTime,
  });
};
