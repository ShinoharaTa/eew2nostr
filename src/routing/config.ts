import * as fs from "node:fs";
import { SEVERITY_ORDER } from "./types.js";
import type { RoutingConfig } from "./types.js";

export const DEFAULT_ROUTING_CONFIG_PATH = "./config/routing.json";

const HAZARDS = new Set([
  "eew",
  "earthquake",
  "tsunami",
  "volcano",
  "weather",
  "sediment",
  "flood",
  "tornado",
  "heavy-rain",
  "megaquake",
]);

const KINDS = new Set(["forecast", "observed", "action"]);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// 設定の不備はその場で落とす。防災システムとして、
// 黙って一部の配信先が抜けたまま動くより安全。
export const validateRoutingConfig = (raw: unknown): RoutingConfig => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ルーティング設定はオブジェクトである必要があります。");
  }
  const { accounts, routes } = raw as Record<string, unknown>;
  if (typeof accounts !== "object" || accounts === null) {
    throw new Error("ルーティング設定に accounts がありません。");
  }
  if (!Array.isArray(routes)) {
    throw new Error("ルーティング設定に routes がありません。");
  }

  const accountKeys = new Set(Object.keys(accounts as object));
  if (accountKeys.size === 0) {
    throw new Error("ルーティング設定にアカウントが1つも定義されていません。");
  }
  for (const [key, value] of Object.entries(accounts as object)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`アカウント ${key} の定義がオブジェクトではありません。`);
    }
    const account = value as Record<string, unknown>;
    // 秘密情報を直接書いていないか確かめる。設定に持たせるのは環境変数名だけ。
    for (const [name, requiredEnvKeys] of [
      ["nostr", ["hexEnv"]],
      ["bluesky", ["identifierEnv", "passwordEnv"]],
      ["concrnt", ["subkeyEnv"]],
    ] as const) {
      const sns = account[name];
      if (sns === undefined) continue;
      if (typeof sns !== "object" || sns === null) {
        throw new Error(`アカウント ${key} の ${name} の定義が不正です。`);
      }
      for (const envKey of requiredEnvKeys) {
        const envName = (sns as Record<string, unknown>)[envKey];
        if (typeof envName !== "string" || envName === "") {
          throw new Error(
            `アカウント ${key} の ${name} に ${envKey} が指定されていません。`,
          );
        }
      }
    }
  }

  routes.forEach((route, index) => {
    if (typeof route !== "object" || route === null) {
      throw new Error(`routes[${index}] がオブジェクトではありません。`);
    }
    const { to, when } = route as Record<string, unknown>;
    if (typeof to !== "string" || !accountKeys.has(to)) {
      throw new Error(
        `routes[${index}] の to (${String(to)}) が accounts に存在しません。`,
      );
    }
    if (when === undefined) return;
    if (typeof when !== "object" || when === null) {
      throw new Error(
        `routes[${index}] の when がオブジェクトではありません。`,
      );
    }
    const condition = when as Record<string, unknown>;
    for (const field of ["hazard", "hazardNot"] as const) {
      const value = condition[field];
      if (value === undefined) continue;
      if (!isStringArray(value)) {
        throw new Error(
          `routes[${index}] の ${field} は文字列の配列にします。`,
        );
      }
      for (const hazard of value) {
        if (!HAZARDS.has(hazard)) {
          throw new Error(
            `routes[${index}] に未知の hazard があります: ${hazard}`,
          );
        }
      }
    }
    if (condition.kind !== undefined) {
      if (!isStringArray(condition.kind)) {
        throw new Error(`routes[${index}] の kind は文字列の配列にします。`);
      }
      for (const kind of condition.kind) {
        if (!KINDS.has(kind)) {
          throw new Error(`routes[${index}] に未知の kind があります: ${kind}`);
        }
      }
    }
    if (
      condition.minSeverity !== undefined &&
      !SEVERITY_ORDER.includes(condition.minSeverity as never)
    ) {
      throw new Error(
        `routes[${index}] の minSeverity が不正です: ${String(condition.minSeverity)}`,
      );
    }
    if (condition.state !== undefined && !isStringArray(condition.state)) {
      throw new Error(`routes[${index}] の state は文字列の配列にします。`);
    }
  });

  return raw as RoutingConfig;
};

export const loadRoutingConfig = (path: string): RoutingConfig => {
  if (!fs.existsSync(path)) {
    throw new Error(`ルーティング設定が見つかりません: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`ルーティング設定の JSON を解析できません: ${path}`, {
      cause: e,
    });
  }
  return validateRoutingConfig(parsed);
};
