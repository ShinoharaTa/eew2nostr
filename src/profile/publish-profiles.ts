import dotenv from "dotenv";
import { logger } from "../logger.js";
import { NostrPublisher } from "../publisher/nostr.js";
import {
  loadProfileConfig,
  parseArgs,
  resolveSecretKey,
} from "./profile-config.js";

dotenv.config();

const DEFAULT_RELAYS = [
  "wss://relay-jp.shino3.net",
  "wss://yabu.me",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
];

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = loadProfileConfig(args.configPath);

  const targets = Object.entries(config.accounts).filter(
    ([key]) => args.account === null || key === args.account,
  );
  if (targets.length === 0) {
    throw new Error(`アカウント ${args.account} は設定に存在しません。`);
  }

  // 発行前に全アカウントの秘密鍵を解決し、途中で失敗して
  // 一部だけ反映された状態にならないようにする
  const resolved = targets.map(([key, account]) => ({
    key,
    account,
    hex: args.dryRun ? "" : resolveSecretKey(key, account.hexEnv, process.env),
  }));

  for (const { key, account, hex } of resolved) {
    const relays = account.relays ?? DEFAULT_RELAYS;
    if (args.dryRun) {
      logger.info(`[dry-run] ${key} の kind 0 は発行しません`, {
        hexEnv: account.hexEnv,
        relays,
        profile: account.profile,
      });
      continue;
    }
    const publisher = new NostrPublisher(hex, relays);
    try {
      const eventId = await publisher.publishMetadata(account.profile);
      logger.info(`${key} の kind 0 を発行しました`, { eventId, relays });
    } finally {
      publisher.dispose();
    }
  }
};

main().catch((error) => {
  logger.error("プロフィールの発行に失敗しました", { err: error });
  process.exit(1);
});
