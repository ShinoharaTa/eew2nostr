import type { AccountConfig, RoutingConfig } from "../routing/types.js";
import { BskyPublisher } from "./bsky.js";
import { ConcrntPublisher } from "./concrnt.js";
import { NostrPublisher } from "./nostr.js";

// アカウント1つ分の各SNSクライアント。
// 環境変数が揃っていない経路は null になり、投稿せずコンソールに出す。
export interface AccountClients {
  key: string;
  label: string;
  nostr: NostrPublisher | null;
  bluesky: BskyPublisher | null;
  concrnt: ConcrntPublisher | null;
}

export const SNS_NAMES = ["nostr", "bluesky", "concrnt"] as const;
export type SnsName = (typeof SNS_NAMES)[number];

const value = (
  env: NodeJS.ProcessEnv,
  name: string | undefined,
): string | null => {
  if (!name) return null;
  const found = env[name];
  return found && found !== "" ? found : null;
};

// 鍵が揃っている経路だけクライアントを作る。
// 揃っていない経路は null のままで、テストモードとして扱う。
export const buildAccount = (
  key: string,
  account: AccountConfig,
  defaultRelays: string[],
  env: NodeJS.ProcessEnv = process.env,
): AccountClients => {
  const hex = value(env, account.nostr?.hexEnv);
  const identifier = value(env, account.bluesky?.identifierEnv);
  const password = value(env, account.bluesky?.passwordEnv);
  const subkey = value(env, account.concrnt?.subkeyEnv);
  return {
    key,
    label: account.label ?? key,
    nostr: hex
      ? new NostrPublisher(hex, account.nostr?.relays ?? defaultRelays)
      : null,
    bluesky:
      identifier && password ? new BskyPublisher(identifier, password) : null,
    concrnt: subkey
      ? new ConcrntPublisher(
          subkey,
          value(env, account.concrnt?.channelEnv) ?? undefined,
        )
      : null,
  };
};

export const buildAccounts = (
  config: RoutingConfig,
  defaultRelays: string[],
  env: NodeJS.ProcessEnv = process.env,
): Map<string, AccountClients> =>
  new Map(
    Object.entries(config.accounts).map(([key, account]) => [
      key,
      buildAccount(key, account, defaultRelays, env),
    ]),
  );

// 接続を要するクライアントを繋ぐ。鍵が無い経路は何もしない。
export const initAccounts = async (
  accounts: Map<string, AccountClients>,
): Promise<void> => {
  for (const account of accounts.values()) {
    await account.bluesky?.init();
    await account.concrnt?.init();
  }
};

export const disposeAccounts = (
  accounts: Map<string, AccountClients>,
): void => {
  for (const account of accounts.values()) account.nostr?.dispose();
};
