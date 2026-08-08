import { parseISO } from "date-fns";
import { UNKNOWN_INTENSITY } from "../classify/intensity.js";
import { logger } from "../logger.js";
import type { JsonSchema } from "../types/eew";

export type EEWReport = {
  isTest: boolean;
  id: string;
  isLast: boolean;
  // 緊急地震速報 (警報) かどうか。予想最大震度5弱以上で発表される。
  // 震度から推測せず電文の値をそのまま使う。
  isWarning: boolean;
  serial: string | null;
  originTime: Date | null;
  reportTime: Date;
  place: string;
  latitude: number;
  longitude: number;
  depth: number;
  magnitude: string;
  // 予想最大震度の下限。to が "over" のときはこちらが表示に使われる。
  forecastFrom: string;
  forecast: string;
  forecastLg: string | null;
};

// 電文の分類。取消報と判定不能を区別する。
// 以前はどちらも "cancel" として捨てていたため、取消が記録にも
// 配信にも反映されなかった。
export type ParsedEEW =
  | { type: "report"; report: EEWReport }
  | { type: "cancelled"; id: string }
  | { type: "ignore" };

export class EEWParser {
  parse(data: JsonSchema): ParsedEEW {
    const cancelled = data.infoType === "取消" || data.body.isCanceled === true;
    if (cancelled && data.eventId) {
      logger.info("緊急地震速報の取消報を受信しました", {
        eventId: data.eventId,
        serialNo: data.serialNo,
      });
      return { type: "cancelled", id: data.eventId };
    }
    if (!data.body.earthquake || !data.eventId) {
      logger.info("telegram skipped (no earthquake or eventId)", {
        eventId: data.eventId,
        serialNo: data.serialNo,
        infoType: data.infoType,
      });
      return { type: "ignore" };
    }
    return { type: "report", report: this.toReport(data) };
  }

  private toReport(data: JsonSchema): EEWReport {
    if (!data.body.earthquake || !data.eventId) {
      throw new Error("earthquake または eventId がありません。");
    }
    return {
      isTest: data.status === "通常",
      id: data.eventId,
      isLast: data.body.isLastInfo,
      isWarning: data.body.isWarning === true,
      serial: data.serialNo,
      originTime: data.body.earthquake.originTime
        ? parseISO(data.body.earthquake.originTime)
        : null,
      reportTime: parseISO(data.reportDateTime),
      place: data.body.earthquake.hypocenter.name,
      latitude: Number(
        data.body.earthquake.hypocenter.coordinate.latitude.value,
      ),
      longitude: Number(
        data.body.earthquake.hypocenter.coordinate.longitude.value,
      ),
      depth: Number(data.body.earthquake.hypocenter.depth.value),
      magnitude:
        data.body.earthquake.magnitude.value ??
        data.body.earthquake.magnitude.condition ??
        "不明",
      forecastFrom: data.body.intensity
        ? data.body.intensity.forecastMaxInt.from
        : UNKNOWN_INTENSITY,
      forecast: data.body.intensity
        ? data.body.intensity.forecastMaxInt.to
        : UNKNOWN_INTENSITY,
      forecastLg: data.body.intensity?.forecastMaxLgInt
        ? data.body.intensity.forecastMaxLgInt.to
        : null,
    };
  }
}
