import * as fs from "node:fs";

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
  // 秘密鍵を保持する環境変数名。秘密鍵そのものは設定ファイルに書かない。
  hexEnv: string;
  // 発行先リレー。省略時は既定のリレーを使う。
  relays?: string[];
  profile: NostrProfile;
}

export interface ProfileConfig {
  accounts: Record<string, AccountProfile>;
}

export const DEFAULT_PROFILE_CONFIG_PATH = "./config/profiles.json";

export interface PublishArgs {
  configPath: string;
  dryRun: boolean;
  // 指定したアカウントだけ発行する。null なら全件。
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

// 設定の不備は起動時に落とす。防災システムとして、
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
  for (const [key, value] of entries) {
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

// 秘密鍵を環境変数から解決する。未設定はエラーにして取り違えを防ぐ。
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
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `環境変数 ${hexEnv} の値が64桁の16進数ではありません (アカウント ${accountKey})。`,
    );
  }
  return hex;
};
