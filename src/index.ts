import axios from "axios";
import dotenv from "dotenv";
import minimist from "minimist";
import { setTimeout } from "timers/promises";
import WebSocket from "ws";
import { decompressData, eewReport, generateEEWMessage } from "./eew.js";
import { publish, publishEEW } from "./nostr.js";

dotenv.config();
const { EEW_TOKEN } = process.env;

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
        eewState[content.id] = await publish(
          eewMessage,
          content.reportTime,
          targetEv,
        );
        await publishEEW(JSON.stringify(content), content.reportTime);
      } catch (e) {
        console.error(e);
      }
    }
  });

  websocket.on("close", () => {
    console.log("WebSocket connection closed");
  });
};

const getArray = (array: string[], count: number) => {
  const index = count % array.length;
  return array[index];
};
const magnitude = ["1.0", "2.1", "3.3", "4.5", "5.6", "6.8", "7.0", "8.2"];
const forecast = ["3", "4", "5-", "5+", "6-", "6+", "7", "over", "不明"];

const publich_test_mode = async () => {
  console.log("eew publish test start");
  const getNow = () => Math.floor(Date.now() / 1000);
  const now = new Date();
  try {
    for (let count = 0; count < 10; count++) {
      const content: eewReport = {
        id: `time_${getNow()}`,
        serial: count,
        originTime: now,
        reportTime: new Date(),
        place: "shinoharaDC",
        latitude: 35.687,
        longitude: 139.725,
        depth: 10,
        magnitude: getArray(magnitude, count),
        forecast: getArray(forecast, count),
      };
      await publishEEW(JSON.stringify(content), content.reportTime, true);
      await setTimeout(2000);
    }
  } catch (e) {
    console.error(e);
  }
  process.exit();
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

if (isPublishTest) {
  publich_test_mode();
} else {
  await publish("EEW System start", new Date());
  main();
}
