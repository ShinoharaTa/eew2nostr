import { setTimeout } from "node:timers/promises";
import type { ReplyRef } from "@atproto/api/dist/client/types/app/bsky/feed/post.js";
import axios from "axios";
import dotenv from "dotenv";
import WebSocket from "ws";
import { BskyInit, BskyPublish } from "./bsky.js";
import { ConcrntPublish } from "./concrnt.js";
import { EEWSystem } from "./eew.js";
import { logger } from "./logger.js";
import { publish, publishEEW } from "./nostr.js";

dotenv.config();
const { EEW_TOKEN, OWNER } = process.env;
const owner = OWNER ?? "";

interface PostObject {
  nostr?: { root: string | null; parent: string | null };
  bluesky?: ReplyRef;
  concrnt?: { root: string };
}
const posts = new Map<string, PostObject>();
const eew = new EEWSystem();

// WebSocket接続の開始
const startWebSocket = (url: string) => {
  logger.info("web socket start");
  const websocket = new WebSocket(url, ["dmdata.v2"]);

  websocket.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "ping") {
      websocket.send(JSON.stringify({ type: "pong", pingId: msg.pingId }));
    }
    if (msg.type === "data") {
      if (msg.head.test) {
        logger.info("test ok.");
        return;
      }
      logger.info(msg);
      try {
        const content = await eew.decompressData(msg.body);
        const eewItem = eew.objectMapping(content);
        if (eewItem === "cancel") {
          content.eventId;
          return;
        }
        if (!eewItem.id) return;
        const eewMessage = eew.generateEEWMessage(eewItem);
        const postInfo = posts.get(eewItem.id) ?? {};
        const [nostrResult, bskyResult, concrntResult] = await Promise.all([
          (async () => {
            const nostrEventId = await publish({
              content: eewMessage,
              time: eewItem.reportTime,
              reply: postInfo.nostr,
            });
            await publishEEW(JSON.stringify(content), eewItem.reportTime);
            return nostrEventId;
          })(),
          (async () => {
            const bskyPostId = await BskyPublish(eewMessage, postInfo.bluesky);
            return bskyPostId;
          })(),
          (async () => {
            const concrntPostId = await ConcrntPublish(
              eewMessage,
              postInfo.concrnt,
            );
            return concrntPostId;
          })(),
        ]);
        if (postInfo.nostr) postInfo.nostr.parent = nostrResult;
        else postInfo.nostr = { root: nostrResult, parent: null };
        if (postInfo.bluesky) postInfo.bluesky.parent = bskyResult;
        else postInfo.bluesky = { root: bskyResult, parent: bskyResult };
        if (concrntResult) postInfo.concrnt = { root: concrntResult.id };
        posts.set(eewItem.id, postInfo);
      } catch (e) {
        logger.error(e);
      }
    }
    if (msg.type === "start") {
      logger.info("ws start", msg);
    }
    if (msg.type === "error") {
      await publish({
        content: `EEW System on error.\n${msg.error}`,
        time: new Date(),
        mentions: [owner],
      });
      logger.info(msg);
      setTimeout(300000);
      process.exit();
    }
  });
  websocket.on("close", async () => {
    await publish({
      content: "EEW System Connection Closed",
      time: new Date(),
      mentions: [owner],
    });
    logger.info("WebSocket connection closed");
    process.exit();
  });
  websocket.on("error", async (ev) => {
    await publish({
      content: `EEW System on error.\n${ev.message}`,
      time: new Date(),
      mentions: [owner],
    });
    logger.info(ev);
    process.exit();
  });
};

const main = async () => {
  await publish({
    content: "EEW System start",
    time: new Date(),
    mentions: [owner],
  });
  await BskyInit();
  await BskyPublish("EEW System start");
  await ConcrntPublish("EEW System start");

  const params = {
    classifications: ["eew.forecast"],
    test: "including",
    formatMode: "json",
    types: ["VXSE45", "VXSE42"],
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
      logger.error(error.response.status, error.response.data);
    });
};

main();
