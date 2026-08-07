import { format, parseISO } from "date-fns";
import {
  UNKNOWN_INTENSITY,
  forecastIntensityLabel,
  forecastIntensityValue,
} from "../classify/intensity.js";
import { logger } from "../logger.js";
import {
  FOOTER,
  type Tier,
  headline,
  intensityColor,
  shakingCallToAction,
  titleWithEmoji,
} from "../publisher/style.js";
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

  // 取消報の投稿文。取り消された事実だけを短く伝える。
  // 取消は危険が去った知らせなので、装飾は一番軽い段階に落とす。
  generateCancelMessage(): string {
    return [
      headline("note", "📳 緊急地震速報 取消"),
      "",
      "先ほどの緊急地震速報は取り消されました。",
      "",
      "#eew",
      "",
      FOOTER,
    ].join("\n");
  }

  generateEEWMessage(content: EEWReport): string {
    // 見出しは気象庁の公式名称に合わせる。
    // 警報は予想最大震度5弱以上で発表され、命を守る行動が要る段階。
    const tier: Tier = content.isWarning ? "act" : "warn";
    const serial = content.isLast
      ? "最終報"
      : content.serial
        ? `第${content.serial}報`
        : "";
    const title = `緊急地震速報（${content.isWarning ? "警報" : "予報"}）${serial}`;

    // 予想震度は from / to の範囲。to だけを見ると "over" が表に出る。
    const value = forecastIntensityValue(
      content.forecastFrom,
      content.forecast,
    );
    const color = intensityColor(value);
    const intensity = [
      `${color ? `${color} ` : ""}${forecastIntensityLabel(content.forecastFrom, content.forecast)}　${content.place}`,
      content.forecastLg && content.forecastLg !== "0"
        ? `（長周期地震動階級 ${content.forecastLg}）`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    // 震源名は震度の行に出ているため繰り返さない。
    const hypocenter = [
      content.originTime ? `${format(content.originTime, "HH:mm")}発生` : null,
      `M${content.magnitude}`,
      Number.isFinite(content.depth) ? `深さ${content.depth}km` : null,
    ]
      .filter(Boolean)
      .join(" / ");

    return [
      headline(tier, titleWithEmoji(tier, title, "eew")),
      intensity,
      hypocenter,
      // 警報は予想最大震度5弱以上で発表される。震度が決まらなくても
      // 警報である事実は確かなので呼びかけは残す。
      shakingCallToAction("forecast", value) ??
        (content.isWarning ? "強い揺れに注意してください。" : null),
      "#eew",
      FOOTER,
    ]
      .filter((part) => part !== null && part !== "")
      .join("\n\n");
  }
}
