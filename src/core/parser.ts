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

export class EEWParser {
  objectMapping(data: JsonSchema): EEWReport | "cancel" {
    if (!data.body.earthquake || !data.eventId) {
      logger.info("telegram skipped (no earthquake or eventId)", {
        eventId: data.eventId,
        serialNo: data.serialNo,
        infoType: data.infoType,
      });
      return "cancel";
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
