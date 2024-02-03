import axios from "axios";
import dotenv from "dotenv";
import minimist from "minimist";
import WebSocket from "ws";
import { decompressData, eewReport, generateEEWMessage } from "./eew.js";
import { publish, publishEEW } from "./nostr.js";

dotenv.config();
const { EEW_TOKEN } = process.env;

const args = minimist(process.argv.slice(2));
const isPublishTest = args.publish === "true";

const eewState: { [key: string]: string } = {};

await publish("EEW System start", new Date());

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

if (isPublishTest) {
  console.log("eew publish test start");
  const getNow = () => Math.floor(Date.now() / 1000);
  const count = 1;
  const now = new Date();
  const content: eewReport = {
    id: `time_${getNow()}`,
    serial: count,
    originTime: now,
    reportTime: new Date(),
    place: "shinoharaDC",
    latitude: 35.687,
    longitude: 139.725,
    depth: 10,
    magnitude: "3.1",
    forecast: "3",
  };
  await publishEEW(JSON.stringify(content), content.reportTime, true);
  process.exit();
}

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
