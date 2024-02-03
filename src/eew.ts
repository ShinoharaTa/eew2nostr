import { gunzip } from "zlib";
import { format, parseISO } from "date-fns";

export const decompressData = (data: string): Promise<eewReport> => {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(data, "base64");
    gunzip(buffer, (err, decompressed) => {
      if (err) {
        reject(err);
      } else {
        const decompressedString = decompressed.toString();
        try {
          const data = JSON.parse(decompressedString);
          const reportItem: eewReport = {
            id: data.eventId,
            serial: Number(data.serialNo),
            originTime: parseISO(data.body.earthquake.originTime),
            reportTime: parseISO(data.reportDateTime),
            place: data.body.earthquake.hypocenter.name,
            latitude: Number(
              data.body.earthquake.hypocenter.coordinate.latitude.value,
            ),
            longitude: Number(
              data.body.earthquake.hypocenter.coordinate.longitude.value,
            ),
            depth: Number(data.body.earthquake.hypocenter.depth.value),
            magnitude: data.body.earthquake.magnitude.value,
            forecast: data.body.intensity.forecastMaxInt.to,
          };
          resolve(reportItem);
        } catch (error) {
          console.log(decompressedString);
          reject("parse error.");
        }
      }
    });
  });
};

export const generateEEWMessage = (content: eewReport, testMode?: boolean) => {
  let message = "";
  if (testMode) message += "※テスト投稿\n";
  const alertTime = format(content.originTime, "HH時mm分");
  message += `【緊急地震速報】${alertTime}\n`;
  message += "\n";
  message += `${content.place}\n`;
  message += `震度${content.forecast}（M${content.magnitude}）\n`;
  message += "\n";
  message += "※このシステムは試験運用中です。突然終了する場合があります。\n";
  message += "#eew";
  return message;
};

export type eewReport = {
  id: string;
  serial: number;
  originTime: Date;
  reportTime: Date;
  place: string;
  latitude: number;
  longitude: number;
  depth: number;
  magnitude: string;
  forecast: string;
};
