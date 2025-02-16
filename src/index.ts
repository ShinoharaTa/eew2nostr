import { setTimeout } from "node:timers/promises";
import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post.js";
import axios from "axios";
import dotenv from "dotenv";
import minimist from "minimist";
import WebSocket from "ws";
import { BskyInit, BskyPublish } from "./bsky.js";
import { ConcrntPublish } from "./concrnt.js";
import { decompressData, type eewReport, generateEEWMessage } from "./eew.js";
import {
  // getNpub,
  // isReplyToUser,
  publish,
  publishEEW,
  // subscribe,
} from "./nostr.js";

dotenv.config();
const { EEW_TOKEN, OWNER } = process.env;
const owner = OWNER ?? "";
const args = minimist(process.argv.slice(2));
const isPublishTest = args.publish === "true";

const eewState: { [key: string]: string } = {};
const eewStateBsky: { [key: string]: ReplyRef } = {};
const eewStateConcrnt: { [key: string]: string } = {};

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
        await Promise.all([
          async () => {
            const targetEv =
              content.id in eewState ? eewState[content.id] : null;
            eewState[content.id] = await publish({
              content: eewMessage,
              time: content.reportTime,
              targetEventId: targetEv,
            });
            await publishEEW(JSON.stringify(content), content.reportTime);
          },
          async () => {
            const targetPost =
              content.id in eewStateBsky ? eewStateBsky[content.id] : undefined;
            const bskyPostResult = await BskyPublish(eewMessage, targetPost);
            if (bskyPostResult) {
              eewStateBsky[content.id].parent = bskyPostResult;
              if (!eewStateBsky[content.id].root)
                eewStateBsky[content.id].root = bskyPostResult;
            }
          },
          async () => {
            const targetId =
              content.id in eewStateConcrnt
                ? eewStateConcrnt[content.id]
                : undefined;
            const result = await ConcrntPublish(eewMessage, targetId);
            if (result) {
              eewStateConcrnt[content.id] = result.id;
            }
          },
        ]);
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
    process.exit();
  });
  websocket.on("error", async (ev) => {
    await publish({
      content: `EEW System on error.\n${ev.message}`,
      time: new Date(),
      mentions: [owner],
    });
    console.log(ev);
    process.exit();
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

  // subscribe(async (ev) => {
  //   try {
  //     const isReply = isReplyToUser(ev);
  //     if (isReply && ev.pubkey === owner) {
  //       const npub = getNpub();
  //       if (ev.content.match(new RegExp(`^(nostr:${npub}\\s+)?生きてる？`))) {
  //         publish({
  //           content: "生きてる",
  //           time: new Date(),
  //           mentions: [ev.pubkey],
  //         });
  //       } else if (
  //         ev.content.match(new RegExp(`^(nostr:${npub}\\s+)?再起動`))
  //       ) {
  //         await publish({
  //           content: "再起動します。",
  //           time: new Date(),
  //           mentions: [ev.pubkey],
  //         });
  //         process.exit();
  //       } else {
  //         publish({
  //           content: "コマンド確認して",
  //           time: new Date(),
  //           mentions: [ev.pubkey],
  //         });
  //       }
  //     }
  //   } catch (ex) {
  //     console.error(ex);
  //   }
  // });
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
  await BskyInit();
  await BskyPublish("EEW System start");
  main();
}
