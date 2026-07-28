import * as fs from "node:fs";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

// kind 0 の content に入れる項目 (NIP-01 / NIP-05 / NIP-24)。
// 未知のキーもそのまま通せるよう索引シグネチャを持たせる。
export interface NostrProfile {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
  [key: string]: unknown;
}

export interface AccountProfile {
  // ログや設定の見通しのための表示名。識別には使わない。
  label?: string;
  // 秘密鍵を保持する環境変数名。秘密鍵そのものは設定ファイルに書かない。
  hexEnv: string;
  // 発行先リレー。省略時は既定のリレーを使う。
  relays?: string[];
  profile: NostrProfile;
}

// 配信アカウントは鍵ごとに分かれるため、公開鍵を識別子にする。
// キーは npub でも64桁の16進数でもよい。
export interface ProfileConfig {
  accounts: Record<string, AccountProfile>;
}

export const DEFAULT_PROFILE_CONFIG_PATH = "./config/profiles.json";

export interface PublishArgs {
  configPath: string;
  dryRun: boolean;
  // 指定した公開鍵のアカウントだけ発行する。null なら全件。
  account: string | null;
}

export const parseArgs = (argv: string[]): PublishArgs => {
  const args: PublishArgs = {
    configPath: DEFAULT_PROFILE_CONFIG_PATH,
    dryRun: false,
    account: null,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--account=")) args.account = arg.slice(10);
    else if (arg.startsWith("--config=")) args.configPath = arg.slice(9);
  }
  return args;
};

const HEX64 = /^[0-9a-f]{64}$/i;

// npub / 16進数のどちらで書かれていても16進数の公開鍵に揃える
export const normalizePubkey = (value: string): string => {
  if (HEX64.test(value)) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    const decoded = decode(value);
    if (decoded.type !== "npub") {
      throw new Error(`npub ではありません: ${value}`);
    }
    return decoded.data.toLowerCase();
  }
  throw new Error(`公開鍵は npub か64桁の16進数で指定してください: ${value}`);
};

// 設定の不備はその場で落とす。防災システムとして、
// 黙って一部のアカウントが未設定のまま動くより安全。
export const validateProfileConfig = (raw: unknown): ProfileConfig => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("プロフィール設定はオブジェクトである必要があります。");
  }
  const accounts = (raw as { accounts?: unknown }).accounts;
  if (typeof accounts !== "object" || accounts === null) {
    throw new Error("プロフィール設定に accounts がありません。");
  }
  const entries = Object.entries(accounts as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("プロフィール設定にアカウントが1つも定義されていません。");
  }
  const seen = new Map<string, string>();
  for (const [key, value] of entries) {
    // キーが公開鍵として妥当か確認する
    const pubkey = normalizePubkey(key);
    const duplicate = seen.get(pubkey);
    if (duplicate) {
      throw new Error(
        `同じ公開鍵が重複して定義されています: ${duplicate} と ${key}`,
      );
    }
    seen.set(pubkey, key);

    if (typeof value !== "object" || value === null) {
      throw new Error(`アカウント ${key} の定義がオブジェクトではありません。`);
    }
    const account = value as Record<string, unknown>;
    if (typeof account.hexEnv !== "string" || account.hexEnv === "") {
      throw new Error(`アカウント ${key} に hexEnv が指定されていません。`);
    }
    if (typeof account.profile !== "object" || account.profile === null) {
      throw new Error(`アカウント ${key} に profile がありません。`);
    }
    if (
      account.relays !== undefined &&
      (!Array.isArray(account.relays) ||
        account.relays.some((relay) => typeof relay !== "string"))
    ) {
      throw new Error(
        `アカウント ${key} の relays は文字列の配列にしてください。`,
      );
    }
  }
  return raw as ProfileConfig;
};

export const loadProfileConfig = (path: string): ProfileConfig => {
  if (!fs.existsSync(path)) {
    throw new Error(`プロフィール設定が見つかりません: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`プロフィール設定の JSON を解析できません: ${path}`, {
      cause: e,
    });
  }
  return validateProfileConfig(parsed);
};

export const derivePubkey = (hex: string): string =>
  getPublicKey(new Uint8Array(Buffer.from(hex, "hex"))).toLowerCase();

// 環境変数の秘密鍵から公開鍵を導く。設定を書く際の突き合わせに使う。
// 未設定や形式不正は例外にせず理由を返し、dry-run を鍵なしでも通す。
export const inspectKey = (
  hexEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): { pubkey: string | null; reason: string | null } => {
  const hex = env[hexEnv];
  if (!hex) return { pubkey: null, reason: `${hexEnv} が未設定です` };
  if (!HEX64.test(hex))
    return { pubkey: null, reason: `${hexEnv} が64桁の16進数ではありません` };
  return { pubkey: derivePubkey(hex), reason: null };
};

// 秘密鍵を環境変数から解決し、設定のキーである公開鍵と一致するか確かめる。
// 鍵を取り違えたまま kind 0 を発行すると別アカウントのプロフィールを
// 上書きしてしまうため、発行前に必ず突き合わせる。
export const resolveSecretKey = (
  accountKey: string,
  hexEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const hex = env[hexEnv];
  if (!hex) {
    throw new Error(
      `アカウント ${accountKey} の秘密鍵が環境変数 ${hexEnv} に設定されていません。`,
    );
  }
  if (!HEX64.test(hex)) {
    throw new Error(
      `環境変数 ${hexEnv} の値が64桁の16進数ではありません (アカウント ${accountKey})。`,
    );
  }
  const expected = normalizePubkey(accountKey);
  const actual = derivePubkey(hex);
  if (actual !== expected) {
    throw new Error(
      `環境変数 ${hexEnv} の秘密鍵はアカウント ${accountKey} のものではありません (この鍵の公開鍵は ${actual})。`,
    );
  }
  return hex;
};
