import dotenv from "dotenv";
import { EEWParser } from "./core/parser.js";
import { AsyncQueue } from "./core/queue.js";
import { logger } from "./logger.js";
import { BskyPublisher } from "./publisher/bsky.js";
import { ConcrntPublisher } from "./publisher/concrnt.js";
import { PublishDispatcher } from "./publisher/dispatcher.js";
import { NostrPublisher } from "./publisher/nostr.js";
import { DmdataReceiver } from "./receiver/dmdata.js";
import type { JsonSchema } from "./types/eew";

dotenv.config();
const {
  EEW_TOKEN,
  HEX,
  OWNER,
  BSKY_IDENTIFIER,
  BSKY_PASSWORD,
  CONCRNT_SUBKEY,
  CONCRNT_CHANNEL,
} = process.env;
const owner = OWNER ?? "";

const relays = [
  "wss://relay-jp.shino3.net",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
];

const main = async () => {
  const nostr = new NostrPublisher(HEX ?? "", relays);
  const bsky = new BskyPublisher(BSKY_IDENTIFIER ?? "", BSKY_PASSWORD ?? "");
  const concrnt = new ConcrntPublisher(CONCRNT_SUBKEY ?? "", CONCRNT_CHANNEL);
  await bsky.init();
  await concrnt.init();

  await nostr.publishNote({
    content: "EEW System start",
    time: new Date(),
    mentions: [owner],
  });
  await bsky.publish("EEW System start");
  await concrnt.publish("EEW System start");

  const dispatcher = new PublishDispatcher(
    new EEWParser(),
    nostr,
    bsky,
    concrnt,
  );

  // 取得層と配信層は内部キューで接続する
  const queue = new AsyncQueue<JsonSchema>();
  const consume = async () => {
    while (true) {
      const telegram = await queue.pop();
      try {
        await dispatcher.handle(telegram);
      } catch (e) {
        logger.error(e);
      }
    }
  };
  consume();

  const receiver = new DmdataReceiver(EEW_TOKEN ?? "", {
    onTelegram: (telegram) => queue.push(telegram),
    onDisconnect: async (reason) => {
      await nostr.publishNote({
        content: reason,
        time: new Date(),
        mentions: [owner],
      });
      process.exit();
    },
  });
  try {
    await receiver.start();
  } catch (error) {
    logger.error(error);
    process.exit(1);
  }
};

main();
