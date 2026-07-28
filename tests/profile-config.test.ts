import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { npubEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  derivePubkey,
  inspectKey,
  loadProfileConfig,
  normalizePubkey,
  parseArgs,
  resolveSecretKey,
  validateProfileConfig,
} from "../src/profile/profile-config";

const secret = generateSecretKey();
const hex = Buffer.from(secret).toString("hex");
const pubkey = getPublicKey(secret);
const npub = npubEncode(pubkey);

const otherSecret = generateSecretKey();
const otherHex = Buffer.from(otherSecret).toString("hex");

const configWith = (key: string) => ({
  accounts: {
    [key]: {
      hexEnv: "HEX",
      profile: { name: "eew_shino3", display_name: "緊急地震速報" },
    },
  },
});

describe("normalizePubkey", () => {
  it("npub を16進数に揃える", () => {
    expect(normalizePubkey(npub)).toBe(pubkey);
  });

  it("16進数はそのまま (小文字化して) 返す", () => {
    expect(normalizePubkey(pubkey.toUpperCase())).toBe(pubkey);
  });

  it("npub と16進数は同じ値になる", () => {
    expect(normalizePubkey(npub)).toBe(normalizePubkey(pubkey));
  });

  it("nsec を渡したら例外にする", () => {
    expect(() => normalizePubkey("nsec1abcdef")).toThrow();
  });

  it("形式が違えば例外にする", () => {
    expect(() => normalizePubkey("main")).toThrow(/npub か64桁の16進数/);
  });
});

describe("validateProfileConfig", () => {
  it("npub をキーにした設定が通る", () => {
    const config = configWith(npub);
    expect(validateProfileConfig(config)).toEqual(config);
  });

  it("16進数をキーにした設定も通る", () => {
    const config = configWith(pubkey);
    expect(validateProfileConfig(config)).toEqual(config);
  });

  it("キーが公開鍵として不正なら例外にする", () => {
    expect(() => validateProfileConfig(configWith("main"))).toThrow(
      /npub か64桁の16進数/,
    );
  });

  it("同じ鍵を npub と16進数で二重定義したら例外にする", () => {
    const config = {
      accounts: {
        [npub]: configWith(npub).accounts[npub],
        [pubkey]: configWith(pubkey).accounts[pubkey],
      },
    };
    expect(() => validateProfileConfig(config)).toThrow(/重複/);
  });

  it("label と relays を指定できる", () => {
    const config = {
      accounts: {
        [npub]: {
          label: "critical",
          hexEnv: "HEX",
          relays: ["wss://a.example"],
          profile: {},
        },
      },
    };
    expect(validateProfileConfig(config)).toEqual(config);
  });

  it.each([
    ["オブジェクトでない", "文字列"],
    ["accounts が無い", {}],
    ["アカウントが空", { accounts: {} }],
  ])("%s 場合は例外にする", (_name, config) => {
    expect(() => validateProfileConfig(config)).toThrow();
  });

  it("hexEnv が無ければ例外にする", () => {
    expect(() =>
      validateProfileConfig({ accounts: { [npub]: { profile: {} } } }),
    ).toThrow(/hexEnv/);
  });

  it("profile が無ければ例外にする", () => {
    expect(() =>
      validateProfileConfig({ accounts: { [npub]: { hexEnv: "HEX" } } }),
    ).toThrow(/profile/);
  });

  it("relays が配列でなければ例外にする", () => {
    expect(() =>
      validateProfileConfig({
        accounts: { [npub]: { hexEnv: "HEX", profile: {}, relays: "wss://a" } },
      }),
    ).toThrow(/relays/);
  });

  it("エラーメッセージにどのアカウントが問題か含める", () => {
    expect(() =>
      validateProfileConfig({ accounts: { [npub]: { profile: {} } } }),
    ).toThrow(new RegExp(npub));
  });
});

describe("loadProfileConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eew-profiles-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ファイルから読み込める", () => {
    const file = path.join(dir, "profiles.json");
    fs.writeFileSync(file, JSON.stringify(configWith(npub)));
    expect(loadProfileConfig(file)).toEqual(configWith(npub));
  });

  it("ファイルが無ければ例外にする", () => {
    expect(() => loadProfileConfig(path.join(dir, "missing.json"))).toThrow(
      /見つかりません/,
    );
  });

  it("JSON が壊れていれば例外にする", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ accounts: ");
    expect(() => loadProfileConfig(file)).toThrow(/解析できません/);
  });

  it("リポジトリの config/profiles.json は妥当", () => {
    const config = loadProfileConfig(
      path.join(__dirname, "../config/profiles.json"),
    );
    const keys = Object.keys(config.accounts);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      // キーが公開鍵として解釈できる
      expect(() => normalizePubkey(key)).not.toThrow();
    }
    for (const account of Object.values(config.accounts)) {
      // 秘密鍵そのものが設定ファイルに書かれていない
      expect(account.hexEnv).not.toMatch(/^[0-9a-f]{64}$/i);
    }
  });
});

describe("resolveSecretKey", () => {
  it("公開鍵と一致する秘密鍵を解決する", () => {
    expect(resolveSecretKey(npub, "HEX", { HEX: hex })).toBe(hex);
  });

  it("キーが16進数でも解決できる", () => {
    expect(resolveSecretKey(pubkey, "HEX", { HEX: hex })).toBe(hex);
  });

  it("未設定なら環境変数名を添えて例外にする", () => {
    expect(() => resolveSecretKey(npub, "HEX_CRITICAL", {})).toThrow(
      /HEX_CRITICAL/,
    );
  });

  it("64桁の16進数でなければ例外にする", () => {
    expect(() => resolveSecretKey(npub, "HEX", { HEX: "nsec1abc" })).toThrow(
      /16進数/,
    );
  });

  // 鍵を取り違えたまま発行すると別アカウントのプロフィールを上書きしてしまう
  it("公開鍵と対応しない秘密鍵は例外にする", () => {
    expect(() => resolveSecretKey(npub, "HEX", { HEX: otherHex })).toThrow(
      /のものではありません/,
    );
  });

  it("取り違えのエラーには実際の公開鍵を含める", () => {
    expect(() => resolveSecretKey(npub, "HEX", { HEX: otherHex })).toThrow(
      new RegExp(derivePubkey(otherHex)),
    );
  });
});

describe("inspectKey", () => {
  it("環境変数から公開鍵を導く", () => {
    expect(inspectKey("HEX", { HEX: hex })).toEqual({
      pubkey,
      reason: null,
    });
  });

  it("未設定なら理由を返して例外にはしない", () => {
    const result = inspectKey("HEX", {});
    expect(result.pubkey).toBeNull();
    expect(result.reason).toMatch(/未設定/);
  });

  it("形式不正なら理由を返して例外にはしない", () => {
    const result = inspectKey("HEX", { HEX: "nsec1abc" });
    expect(result.pubkey).toBeNull();
    expect(result.reason).toMatch(/16進数/);
  });
});

describe("parseArgs", () => {
  it("既定値を返す", () => {
    expect(parseArgs([])).toEqual({
      configPath: "./config/profiles.json",
      dryRun: false,
      account: null,
    });
  });

  it("オプションを解釈する", () => {
    expect(
      parseArgs(["--dry-run", `--account=${npub}`, "--config=./other.json"]),
    ).toEqual({
      configPath: "./other.json",
      dryRun: true,
      account: npub,
    });
  });
});
