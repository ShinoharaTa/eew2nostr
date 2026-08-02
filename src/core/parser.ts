import { format, parseISO } from "date-fns";
import { logger } from "../logger.js";
import type { JsonSchema } from "../types/eew";

export type EEWReport = {
  isTest: boolean;
  id: string;
  isLast: boolean;
  serial: string | null;
  originTime: Date | null;
  reportTime: Date;
  place: string;
  latitude: number;
  longitude: number;
  depth: number;
  magnitude: string;
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
      forecast: data.body.intensity
        ? data.body.intensity.forecastMaxInt.to
        : "不明",
      forecastLg: data.body.intensity?.forecastMaxLgInt
        ? data.body.intensity.forecastMaxLgInt.to
        : null,
    };
  }

  // 取消報の投稿文。取り消された事実だけを短く伝える。
  generateCancelMessage(): string {
    return [
      "【緊急地震速報 取消】",
      "",
      "先ほどの緊急地震速報は取り消されました。",
      "",
      "※テスト運用中です。",
      "#eew",
    ].join("\n");
  }

  generateEEWMessage(content: EEWReport) {
    let message = "";
    const alertTime = content.originTime
      ? format(content.originTime, "HH:mm")
      : "";
    const serial = content.isLast
      ? "(最終報)"
      : content.serial
        ? `(第${content.serial}報)`
        : "";
    message += `【緊急地震速報】${alertTime} ${serial}\n`;
    message += "\n";
    message += `${content.place}\n`;
    message += "\n";
    message += `震度 ${content.forecast ?? " 不明"}（M${content.magnitude}）\n`;
    if (content.forecastLg && content.forecastLg !== "0")
      message += `長周期地震動階級 ${content.forecastLg}\n`;
    message += "\n";
    message += "※このシステムは試験運用中です。突然終了する場合があります。\n";
    message += "#eew";
    return message;
  }
}
