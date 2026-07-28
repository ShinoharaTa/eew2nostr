import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadProfileConfig,
  parseArgs,
  resolveSecretKey,
  validateProfileConfig,
} from "../src/profile/profile-config";

const validConfig = {
  accounts: {
    main: {
      hexEnv: "HEX",
      profile: { name: "eew_shino3", display_name: "緊急地震速報" },
    },
  },
};

describe("validateProfileConfig", () => {
  it("正しい設定はそのまま通る", () => {
    expect(validateProfileConfig(validConfig)).toEqual(validConfig);
  });

  it("relays を指定できる", () => {
    const config = {
      accounts: {
        main: { ...validConfig.accounts.main, relays: ["wss://a.example"] },
      },
    };
    expect(validateProfileConfig(config)).toEqual(config);
  });

  it.each([
    ["オブジェクトでない", "文字列"],
    ["accounts が無い", {}],
    ["アカウントが空", { accounts: {} }],
    ["hexEnv が無い", { accounts: { main: { profile: {} } } }],
    ["profile が無い", { accounts: { main: { hexEnv: "HEX" } } }],
    [
      "relays が配列でない",
      { accounts: { main: { hexEnv: "HEX", profile: {}, relays: "wss://a" } } },
    ],
  ])("%s 場合は例外にする", (_name, config) => {
    expect(() => validateProfileConfig(config)).toThrow();
  });

  it("エラーメッセージにどのアカウントが問題か含める", () => {
    expect(() =>
      validateProfileConfig({ accounts: { critical: { profile: {} } } }),
    ).toThrow(/critical/);
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
    fs.writeFileSync(file, JSON.stringify(validConfig));
    expect(loadProfileConfig(file)).toEqual(validConfig);
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
    expect(Object.keys(config.accounts).length).toBeGreaterThan(0);
    for (const account of Object.values(config.accounts)) {
      // 秘密鍵そのものが設定ファイルに書かれていないこと
      expect(account.hexEnv).not.toMatch(/^[0-9a-f]{64}$/i);
    }
  });
});

describe("resolveSecretKey", () => {
  const hex = "a".repeat(64);

  it("環境変数から秘密鍵を解決する", () => {
    expect(resolveSecretKey("main", "HEX", { HEX: hex })).toBe(hex);
  });

  it("未設定なら環境変数名を添えて例外にする", () => {
    expect(() => resolveSecretKey("critical", "HEX_CRITICAL", {})).toThrow(
      /HEX_CRITICAL/,
    );
  });

  it("64桁の16進数でなければ例外にする", () => {
    expect(() => resolveSecretKey("main", "HEX", { HEX: "nsec1abc" })).toThrow(
      /16進数/,
    );
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
      parseArgs(["--dry-run", "--account=critical", "--config=./other.json"]),
    ).toEqual({
      configPath: "./other.json",
      dryRun: true,
      account: "critical",
    });
  });
});
