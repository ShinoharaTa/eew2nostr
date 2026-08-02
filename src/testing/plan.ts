import * as fs from "node:fs";
import * as path from "node:path";
import { classify } from "../classify/index.js";
import { formatAlertPosts, groupForPosting } from "../publisher/message.js";
import { parseTelegram } from "../receiver/jma-xml.js";

// 実際に取得した電文をそのまま使う。
export const FIXTURE_DIR = "./tests/fixtures/telegrams";

// テスト投稿は自前のリレーだけに送る。
// 公開リレーへ試験用の投稿を撒かないための既定値。
export const DEFAULT_RELAYS = ["wss://relay-jp.shino3.net"];

export interface TestPostArgs {
  types: string[];
  dryRun: boolean;
  relays: string[];
  hexEnv: string;
  // 投稿ではなく、過去のテスト投稿の削除を行う
  cleanup: boolean;
}

export const parseArgs = (argv: string[]): TestPostArgs => {
  const args: TestPostArgs = {
    types: [],
    dryRun: false,
    relays: DEFAULT_RELAYS,
    hexEnv: "HEX_TEST",
    cleanup: false,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--cleanup") args.cleanup = true;
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
