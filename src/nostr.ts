import dotenv from "dotenv";
import { EventTemplate, SimplePool, finishEvent } from "nostr-tools";
import "websocket-polyfill";

dotenv.config();
const { HEX } = process.env;

const pool = new SimplePool();
const relays = [
  "wss://relay-jp.shino3.net",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
];

const testRelays = ["wss://relay-jp.shino3.net"];

export const publish = async (params: {
  content: string;
  time: Date;
  targetEventId?: string | null;
  mentions?: string[];
}) => {
  const ev: EventTemplate<1> = {
    kind: 1,
    content: params.content,
    tags: [],
    created_at: Math.floor(params.time.getTime() / 1000),
  };
  if (params.targetEventId) {
    ev.tags.push(["e", params.targetEventId]);
  }
  if (params.mentions) {
    params.mentions.map((mention) => {
      ev.tags.push(["p", mention]);
    });
  }
  const post = finishEvent(ev, HEX ?? "");
  await Promise.any(pool.publish(relays, post));
  return post.id;
};

export const publishEEW = async (
  content: string,
  time: Date,
  isTest?: boolean,
) => {
  const ev: EventTemplate<30078> = {
    kind: 30078,
    content: content,
    tags: [["d", `eew_alert_system_by_shino3${isTest ? "_test" : ""}`]],
    created_at: Math.floor(time.getTime() / 1000),
  };
  const post = finishEvent(ev, HEX ?? "");
  console.log(post);
  await Promise.any(pool.publish(isTest ? testRelays : relays, post));
  return post.id;
};
