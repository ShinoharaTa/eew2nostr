import dotenv from "dotenv";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { type EventTemplate, finalizeEvent } from "nostr-tools/pure";
import WebSocket from "ws";

dotenv.config();
const HEX = process.env.HEX ?? "";
const nsec = new Uint8Array(Buffer.from(HEX, "hex"));
const relays = [
  "wss://relay-jp.shino3.net",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
];

const testRelays = ["wss://relay-jp.shino3.net"];

export const publish = async (params: {
  content: string;
  time: Date;
  reply?: { root: string | null; parent: string | null };
  mentions?: string[];
}) => {
  const ev: EventTemplate = {
    kind: 1,
    content: params.content,
    tags: [],
    created_at: Math.floor(params.time.getTime() / 1000),
  };
  if (params.reply) {
    if (params.reply.root) ev.tags.push(["e", params.reply.root, "", "root"]);
    if (params.reply.parent)
      ev.tags.push(["e", params.reply.parent, "", "reply"]);
  }
  if (params.mentions) {
    params.mentions.map((mention) => {
      ev.tags.push(["p", mention]);
    });
  }
  const post = finalizeEvent(ev, nsec);
  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool();
  await Promise.any(pool.publish(relays, post));
  return post.id;
};

export const publishEEW = async (
  content: string,
  time: Date,
  isTest?: boolean,
) => {
  const ev: EventTemplate = {
    kind: 7078,
    content: content,
    tags: [["d", `eew_alert_system_by_shino3${isTest ? "_test" : ""}`]],
    created_at: Math.floor(time.getTime() / 1000),
  };
  const post = finalizeEvent(ev, nsec);
  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool();
  await Promise.any(pool.publish(isTest ? testRelays : relays, post));
  return post.id;
};
