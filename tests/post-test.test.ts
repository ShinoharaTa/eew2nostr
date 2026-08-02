// このファイルは src/testing/plan だけを import する。
// CLI 側 (src/testing/post-test) を import すると main() が走り、
// テスト実行のたびに実際の投稿が発生してしまうため。
import {
  availableTypes,
  parseArgs,
  postsForTelegram,
} from "../src/testing/plan";

const DIR = "tests/fixtures/telegrams";

describe("parseArgs", () => {
  // 公開リレーへ試験用の投稿を撒かないよう、既定は自前リレーのみ
  it("既定は自前リレー1本で全種別", () => {
    expect(parseArgs([])).toEqual({
      types: [],
      dryRun: false,
      relays: ["wss://relay-jp.shino3.net"],
      hexEnv: "HEX_TEST",
      cleanup: false,
    });
  });

  it("オプションを解釈する", () => {
    expect(
      parseArgs([
        "--dry-run",
        "--type=VXSE53",
        "--type=VTSE41",
        "--relays=wss://a.example,wss://b.example",
        "--hex-env=HEX_OTHER",
      ]),
    ).toEqual({
      types: ["VXSE53", "VTSE41"],
      dryRun: true,
      relays: ["wss://a.example", "wss://b.example"],
      hexEnv: "HEX_OTHER",
      cleanup: false,
    });
  });

  it("--cleanup を解釈する", () => {
    expect(parseArgs(["--cleanup"]).cleanup).toBe(true);
  });
});

describe("availableTypes", () => {
  it("フィクスチャの電文種別を列挙する", () => {
    const types = availableTypes(DIR);
    expect(types).toEqual(expect.arrayContaining(["VXSE53", "VPWW53"]));
    for (const type of types) expect(type).not.toContain(".xml");
  });
});

describe("postsForTelegram", () => {
  it("電文から投稿文を組み立てる", () => {
    const groups = postsForTelegram("VXSE53", DIR);
    expect(groups).toHaveLength(1);
    expect(groups[0][0]).toContain("【地震情報】");
  });

  // 気象警報は種別ごとに別の投稿になる
  it("同じ電文でも種別が違えば別の投稿群になる", () => {
    expect(postsForTelegram("VPWW53", DIR).length).toBeGreaterThan(1);
  });

  // 分割された投稿は配列で返り、呼び出し側がスレッドに繋ぐ
  it("分割される電文は複数の投稿文を返す", () => {
    const [posts] = postsForTelegram("VXSE62", DIR);
    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThanOrEqual(1);
  });
});
