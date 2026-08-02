import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";
import { npubEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { classify } from "../classify/index.js";
import { logger } from "../logger.js";
import { DiscordNotifier } from "../notifier/discord.js";
import { formatAlertPosts, groupForPosting } from "../publisher/message.js";
import { NostrPublisher } from "../publisher/nostr.js";
import { parseTelegram } from "../receiver/jma-xml.js";

dotenv.config();

// 実際に取得した電文をそのまま使う。
const FIXTURE_DIR = "./tests/fixtures/telegrams";

// テスト投稿は自前のリレーだけに送る。
// 公開リレーへ試験用の投稿を撒かないための既定値。
const DEFAULT_RELAYS = ["wss://relay-jp.shino3.net"];

interface Args {
  types: string[];
  dryRun: boolean;
  relays: string[];
  hexEnv: string;
}

export const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    types: [],
    dryRun: false,
    relays: DEFAULT_RELAYS,
    hexEnv: "HEX_TEST",
  };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--type=")) args.types.push(arg.slice(7));
    else if (arg.startsWith("--relays="))
      args.relays = arg.slice(9).split(",").filter(Boolean);
    else if (arg.startsWith("--hex-env=")) args.hexEnv = arg.slice(10);
  }
  return args;
};

export const availableTypes = (dir: string = FIXTURE_DIR): string[] =>
  fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".xml"))
    .map((name) => path.basename(name, ".xml"))
    .sort();

// 電文1通から、投稿される文面をすべて組み立てる。
export const postsForTelegram = (
  type: string,
  dir: string = FIXTURE_DIR,
): string[][] => {
  const report = parseTelegram(
    fs.readFileSync(path.join(dir, `${type}.xml`), "utf-8"),
  );
  return groupForPosting(classify(type, report)).map((group) =>
    formatAlertPosts(group),
  );
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const types = args.types.length > 0 ? args.types : availableTypes();

  const hex = process.env[args.hexEnv];
  if (!args.dryRun) {
    if (!hex) {
      throw new Error(
        `テスト用の秘密鍵が環境変数 ${args.hexEnv} に設定されていません。`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error(`${args.hexEnv} の値が64桁の16進数ではありません。`);
    }
  }

  if (hex) {
    const pubkey = getPublicKey(new Uint8Array(Buffer.from(hex, "hex")));
    logger.info("投稿するアカウント", { npub: npubEncode(pubkey), pubkey });
  }
  logger.info("テスト投稿を開始します", {
    types,
    relays: args.relays,
    dryRun: args.dryRun,
  });

  const publisher = hex ? new NostrPublisher(hex, args.relays) : null;
  const discord = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL ?? "");
  const results: { type: string; posts: number; eventIds: string[] }[] = [];

  try {
    for (const type of types) {
      for (const posts of postsForTelegram(type)) {
        const eventIds: string[] = [];
        // 分割された投稿はスレッドで繋ぐ
        let root: string | null = null;
        let parent: string | null = null;
        for (const [index, content] of posts.entries()) {
          logger.info(
            `--- ${type} [${index + 1}/${posts.length}] ---\n${content}`,
          );
          if (args.dryRun || publisher === null) continue;
          const eventId = await publisher.publishNote({
            content,
            time: new Date(),
            reply: root ? { root, parent } : undefined,
          });
          eventIds.push(eventId);
          if (root === null) root = eventId;
          else parent = eventId;
        }
        results.push({ type, posts: posts.length, eventIds });
      }
    }
  } finally {
    publisher?.dispose();
  }

  const total = results.reduce((sum, r) => sum + r.posts, 0);
  const published = results.reduce((sum, r) => sum + r.eventIds.length, 0);
  logger.info("テスト投稿が完了しました", {
    telegrams: types.length,
    posts: total,
    published,
    dryRun: args.dryRun,
  });
  if (!args.dryRun && published > 0) {
    await discord.notify(
      `🧪 テスト投稿を実施しました\n電文 ${types.length}件 → 投稿 ${published}件\n宛先: ${args.relays.join(", ")}`,
    );
  }
};

main().catch((error) => {
  logger.error("テスト投稿に失敗しました", { err: error });
  process.exit(1);
});
