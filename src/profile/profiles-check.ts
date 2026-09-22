import dotenv from "dotenv";
import { npubEncode } from "nostr-tools/nip19";
import { logger } from "../logger.js";
import {
  DEFAULT_ROUTING_CONFIG_PATH,
  loadRoutingConfig,
} from "../routing/config.js";
import {
  BLUESKY_DESCRIPTION_LIMIT,
  BLUESKY_DISPLAY_NAME_LIMIT,
  DEFAULT_PROFILE_CONFIG_PATH,
  blueskyLimitErrors,
  countGraphemes,
  inspectKey,
  loadProfileConfig,
  normalizePubkey,
  resolveProfiles,
} from "./profile-config.js";

dotenv.config();

interface CheckArgs {
  configPath: string;
  account: string | null;
}

export const parseArgs = (argv: string[]): CheckArgs => {
  const args: CheckArgs = {
    configPath: DEFAULT_PROFILE_CONFIG_PATH,
    account: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--account=")) args.account = arg.slice(10);
    else if (arg.startsWith("--config=")) args.configPath = arg.slice(9);
  }
  return args;
};

const configured = (name: string | undefined): boolean =>
  name !== undefined && (process.env[name] ?? "") !== "";

// 何も発行せず、設定の妥当性と最終的な文面だけを出す。
// 初回はこれで導出 npub を確認し、routing.json に貼る。
const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const routing = loadRoutingConfig(
    process.env.ROUTING_CONFIG_PATH?.trim() || DEFAULT_ROUTING_CONFIG_PATH,
  );
  const config = loadProfileConfig(args.configPath);

  const keys = Object.keys(routing.accounts).filter(
    (key) => args.account === null || key === args.account,
  );
  if (keys.length === 0) {
    throw new Error(
      `アカウント ${args.account} は routing.json に存在しません。`,
    );
  }

  let problems = 0;
  for (const key of keys) {
    const account = routing.accounts[key];
    logger.info(`=== ${key} (${account.label ?? key}) ===`);
    if (!config.accounts[key]) {
      logger.warn(`${key} はプロフィール設定に無いため同期の対象外です`);
      continue;
    }
    const profiles = resolveProfiles(config, key);

    // Nostr: env の鍵から導いた公開鍵と、設定の npub が一致するか
    if (account.nostr) {
      const inspected = inspectKey(account.nostr.hexEnv, process.env);
      const expected = account.nostr.npub
        ? normalizePubkey(account.nostr.npub)
        : null;
      const status = !inspected.pubkey
        ? (inspected.reason ?? "鍵を読めません")
        : expected === null
          ? "routing.json に nostr.npub が未設定 (発行しません)"
          : inspected.pubkey === expected
            ? "一致"
            : "不一致: この鍵では発行しません";
      if (inspected.pubkey && expected && inspected.pubkey !== expected) {
        problems += 1;
      }
      logger.info("nostr", {
        hexEnv: account.nostr.hexEnv,
        鍵: configured(account.nostr.hexEnv) ? "あり" : "なし",
        設定のnpub: account.nostr.npub ?? null,
        導出したnpub: inspected.pubkey ? npubEncode(inspected.pubkey) : null,
        照合: status,
        kind0: profiles.nostr,
      });
    }

    if (account.bluesky) {
      const limits = blueskyLimitErrors(profiles.bluesky);
      if (limits.length > 0) {
        problems += 1;
        logger.error(`${key}/bluesky は上限を超えています`, { limits });
      }
      logger.info("bluesky", {
        鍵:
          configured(account.bluesky.identifierEnv) &&
          configured(account.bluesky.passwordEnv)
            ? "あり"
            : "なし",
        設定のhandle: account.bluesky.handle ?? null,
        displayName: profiles.bluesky.displayName ?? null,
        [`displayName(≤${BLUESKY_DISPLAY_NAME_LIMIT})`]: countGraphemes(
          profiles.bluesky.displayName ?? "",
        ),
        description: profiles.bluesky.description ?? null,
        [`description(≤${BLUESKY_DESCRIPTION_LIMIT})`]: countGraphemes(
          profiles.bluesky.description ?? "",
        ),
        avatar: profiles.bluesky.avatarUrl ?? null,
        banner: profiles.bluesky.bannerUrl ?? null,
      });
    }

    if (account.concrnt) {
      logger.info("concrnt", {
        鍵: configured(account.concrnt.subkeyEnv) ? "あり" : "なし",
        設定のccid: account.concrnt.ccid ?? null,
        profile: profiles.concrnt,
      });
    }
  }

  if (problems > 0) {
    logger.error(`${problems}件の問題があります。発行前に直してください`);
    process.exit(1);
  }
  logger.info("プロフィール設定に問題はありません (何も発行していません)");
};

main().catch((error) => {
  logger.error("プロフィールの確認に失敗しました", { err: error });
  process.exit(1);
});
