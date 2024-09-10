import axios from "axios";
import dotenv from "dotenv";
import minimist from "minimist";
import cron from "node-cron";
import { setTimeout } from "timers/promises";
import WebSocket from "ws";
import { decompressData, eewReport, generateEEWMessage } from "./eew.js";
import { publish, publishEEW } from "./nostr.js";

dotenv.config();
const { EEW_TOKEN, OWNER } = process.env;
const owner = OWNER ?? "";
const args = minimist(process.argv.slice(2));
const isPublishTest = args.publish === "true";

const eewState: { [key: string]: string } = {};

// WebSocket接続の開始
const startWebSocket = (url: string) => {
  const websocket = new WebSocket(url, ["dmdata.v2"]);

  websocket.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "ping") {
      websocket.send(JSON.stringify({ type: "pong", pingId: msg.pingId }));
    }
    // if (msg.type === "data" && msg.format === "xml") {
    if (msg.type === "data") {
      try {
        const content = await decompressData(msg.body);
        const eewMessage = generateEEWMessage(content);
        // console.log(eewMessage);
        const targetEv = content.id in eewState ? eewState[content.id] : null;
        eewState[content.id] = await publish({
          content: eewMessage,
          time: content.reportTime,
          targetEventId: targetEv,
        });
        await publishEEW(JSON.stringify(content), content.reportTime);
      } catch (e) {
        console.error(e);
      }
    }
  });

  websocket.on("close", async () => {
    await publish({
      content: "EEW System Connection Closed",
      time: new Date(),
      mentions: [owner],
    });
    console.log("WebSocket connection closed");
  });
  websocket.on("error", async (ev) => {
    await publish({
      content: `EEW System on error.\n${ev.message}`,
      time: new Date(),
      mentions: [owner],
    });
    console.log(ev);
  });
};

const getArray = (array: string[], count: number) => {
  const index = count % array.length;
  return array[index];
};
const magnitude = ["3.2", "4.1", "5.0"];
const forecast = ["4", "5-", "5+"];

const publich_test_mode = async (loop?: boolean) => {
  console.log("eew publish test start");
  const getNow = () => Math.floor(Date.now() / 1000);
  const now = new Date();
  try {
    for (let count = 0; count < 3; count++) {
      const content: eewReport = {
        id: `time_${getNow()}`,
        serial: count,
        originTime: now,
        reportTime: new Date(),
        place: "テスト配信報",
        latitude: 35.687,
        longitude: 139.725,
        depth: 5 * count,
        magnitude: getArray(magnitude, count),
        forecast: getArray(forecast, count),
      };
      await publishEEW(JSON.stringify(content), content.reportTime, true);
      await setTimeout(5000);
    }
  } catch (e) {
    console.error(e);
  }
  if (!loop) process.exit();
};

const main = () => {
  const params = {
    classifications: ["eew.forecast"],
    test: "including",
    formatMode: "json",
    types: ["VXSE45"],
  };

  axios
    .post("https://api.dmdata.jp/v2/socket", params, {
      headers: {
        Authorization: `Basic ${EEW_TOKEN}`,
      },
    })
    .then((response) => response.data)
    .then((data) => {
      startWebSocket(data.websocket.url);
    })
    .catch((error) => {
      console.error(error.response.status, error.response.data);
    });
};

// cron.schedule("*/5 * * * *", () => {
//   console.log("5分ごとに実行するテスト配信データ");
//   publich_test_mode(true);
// });

if (isPublishTest) {
  publich_test_mode();
} else {
  await publish({
    content: "EEW System start",
    time: new Date(),
    mentions: [owner],
  });
  main();
}
