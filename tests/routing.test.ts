import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadRoutingConfig,
  validateRoutingConfig,
} from "../src/routing/config";
import { Router, matches, resolveRoutes } from "../src/routing/router";
import type { RouteCondition, RoutingConfig } from "../src/routing/types";

const target = (
  hazard: string,
  severity: string,
  state = "active",
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に文字列で組み立てる
) => ({ hazard, severity, state }) as any;

const config: RoutingConfig = {
  accounts: {
    main: { label: "全体", nostr: { hexEnv: "HEX" } },
    critical: {
      label: "人命に関わる情報",
      nostr: { hexEnv: "HEX_CRITICAL" },
      bluesky: {
        identifierEnv: "BSKY_ID_CRITICAL",
        passwordEnv: "BSKY_PW_CRITICAL",
      },
    },
  },
  routes: [
    { to: "main", when: { hazard: ["eew", "earthquake", "tsunami"] } },
    { to: "main", when: { minSeverity: "warning" } },
    { to: "critical", when: { minSeverity: "emergency" } },
  ],
};

describe("matches", () => {
  it("条件が無ければ全件にマッチする", () => {
    expect(matches(undefined, target("weather", "info"))).toBe(true);
    expect(matches({}, target("weather", "info"))).toBe(true);
  });

  // 同一キー内の配列は OR
  it("hazard は列挙のいずれかに一致すればよい", () => {
    const when: RouteCondition = { hazard: ["eew", "tsunami"] };
    expect(matches(when, target("tsunami", "info"))).toBe(true);
    expect(matches(when, target("weather", "info"))).toBe(false);
  });

  it("minSeverity は閾値として効く", () => {
    const when: RouteCondition = { minSeverity: "warning" };
    expect(matches(when, target("weather", "emergency"))).toBe(true);
    expect(matches(when, target("weather", "warning"))).toBe(true);
    expect(matches(when, target("weather", "advisory"))).toBe(false);
    expect(matches(when, target("weather", "info"))).toBe(false);
  });

  // 異なるキー同士は AND
  it("hazard と minSeverity は両方満たす必要がある", () => {
    const when: RouteCondition = {
      hazard: ["weather"],
      minSeverity: "warning",
    };
    expect(matches(when, target("weather", "warning"))).toBe(true);
    expect(matches(when, target("weather", "advisory"))).toBe(false);
    expect(matches(when, target("earthquake", "warning"))).toBe(false);
  });

  it("state で絞り込める", () => {
    const when: RouteCondition = { state: ["active"] };
    expect(matches(when, target("weather", "warning", "active"))).toBe(true);
    expect(matches(when, target("weather", "warning", "resolved"))).toBe(false);
  });
});

describe("resolveRoutes", () => {
  it("マッチした宛先を返す", () => {
    expect(resolveRoutes(config.routes, target("tsunami", "info"))).toEqual([
      "main",
    ]);
    expect(
      resolveRoutes(config.routes, target("weather", "emergency")),
    ).toEqual(["main", "critical"]);
  });

  // 同じ宛先に複数のルートを向けられる (どれか1つにマッチすれば配信)
  it("同じ宛先を重複して返さない", () => {
    expect(resolveRoutes(config.routes, target("eew", "emergency"))).toEqual([
      "main",
      "critical",
    ]);
  });

  it("どのルートにも当たらなければ空を返す", () => {
    expect(resolveRoutes(config.routes, target("weather", "advisory"))).toEqual(
      [],
    );
  });
});

describe("Router", () => {
  // 鍵が未設定でもルーティングの定義だけ先に用意できる
  it("鍵が無くても設定上の配信先は判定できる", () => {
    const router = new Router(config, {});
    expect(router.route(target("weather", "emergency"))).toEqual([
      "main",
      "critical",
    ]);
    expect(router.deliverable(target("weather", "emergency"))).toEqual([]);
  });

  it("環境変数が揃った経路だけ投稿可能になる", () => {
    const router = new Router(config, { HEX: "a".repeat(64) });
    const deliverable = router.deliverable(target("weather", "emergency"));
    expect(deliverable.map((a) => a.key)).toEqual(["main"]);
    expect(deliverable[0].nostr).toBe(true);
    expect(deliverable[0].bluesky).toBe(false);
  });

  it("SNS ごとに設定の有無を判定する", () => {
    const router = new Router(config, {
      HEX_CRITICAL: "b".repeat(64),
      BSKY_ID_CRITICAL: "id",
      // パスワードが欠けているので bluesky は無効
    });
    const account = router.account("critical");
    expect(account?.nostr).toBe(true);
    expect(account?.bluesky).toBe(false);
  });

  it("空文字の環境変数は未設定として扱う", () => {
    const router = new Router(config, { HEX: "" });
    expect(router.account("main")?.nostr).toBe(false);
  });

  it("未定義のアカウントは null を返す", () => {
    expect(new Router(config, {}).account("nosuch")).toBeNull();
  });
});

describe("validateRoutingConfig", () => {
  it("正しい設定は通る", () => {
    expect(validateRoutingConfig(config)).toEqual(config);
  });

  it.each([
    ["オブジェクトでない", "文字列"],
    ["accounts が無い", { routes: [] }],
    ["routes が無い", { accounts: { main: {} } }],
    ["アカウントが空", { accounts: {}, routes: [] }],
  ])("%s 場合は例外にする", (_name, invalid) => {
    expect(() => validateRoutingConfig(invalid)).toThrow();
  });

  it("存在しない宛先を指すルートは例外にする", () => {
    expect(() =>
      validateRoutingConfig({
        accounts: { main: {} },
        routes: [{ to: "nosuch" }],
      }),
    ).toThrow(/nosuch/);
  });

  it("未知の hazard は例外にする", () => {
    expect(() =>
      validateRoutingConfig({
        accounts: { main: {} },
        routes: [{ to: "main", when: { hazard: ["typhoon"] } }],
      }),
    ).toThrow(/typhoon/);
  });

  it("不正な minSeverity は例外にする", () => {
    expect(() =>
      validateRoutingConfig({
        accounts: { main: {} },
        routes: [{ to: "main", when: { minSeverity: "critical" } }],
      }),
    ).toThrow(/minSeverity/);
  });

  it("環境変数名が欠けていれば例外にする", () => {
    expect(() =>
      validateRoutingConfig({
        accounts: { main: { bluesky: { identifierEnv: "ID" } } },
        routes: [],
      }),
    ).toThrow(/passwordEnv/);
  });
});

describe("loadRoutingConfig", () => {
  it("リポジトリの config/routing.json は妥当", () => {
    const loaded = loadRoutingConfig(
      path.join(__dirname, "../config/routing.json"),
    );
    expect(Object.keys(loaded.accounts).length).toBeGreaterThan(0);
    expect(loaded.routes.length).toBeGreaterThan(0);
  });

  // 設定ファイルに秘密情報を書いていないこと
  it("設定に秘密鍵らしき値が含まれていない", () => {
    const raw = fs.readFileSync(
      path.join(__dirname, "../config/routing.json"),
      "utf-8",
    );
    expect(raw).not.toMatch(/[0-9a-f]{64}/i);
    expect(raw).not.toMatch(/nsec1/);
  });

  it("ファイルが無ければ例外にする", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eew-routing-"));
    expect(() => loadRoutingConfig(path.join(dir, "missing.json"))).toThrow(
      /見つかりません/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
