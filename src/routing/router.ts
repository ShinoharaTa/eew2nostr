import type { AlertKind, HazardType, Severity } from "../classify/types.js";
import {
  type AccountConfig,
  type Route,
  type RouteCondition,
  type RoutingConfig,
  severityRank,
} from "./types.js";

export interface RoutingTarget {
  hazard: HazardType;
  kind: AlertKind;
  severity: Severity;
  state: string;
}

// どのSNSに投稿できるか。環境変数が揃っている経路だけを有効とする。
export interface ResolvedAccount {
  key: string;
  label: string;
  nostr: boolean;
  bluesky: boolean;
  concrnt: boolean;
}

export const matches = (
  condition: RouteCondition | undefined,
  target: RoutingTarget,
): boolean => {
  if (!condition) return true;
  if (condition.hazard && !condition.hazard.includes(target.hazard))
    return false;
  if (condition.kind && !condition.kind.includes(target.kind)) return false;
  if (
    condition.minSeverity &&
    severityRank(target.severity) < severityRank(condition.minSeverity)
  )
    return false;
  if (condition.state && !condition.state.includes(target.state)) return false;
  return true;
};

// 同じ宛先に複数のルートを向けられる。どれか1つにマッチすれば配信する。
export const resolveRoutes = (
  routes: Route[],
  target: RoutingTarget,
): string[] => {
  const accounts: string[] = [];
  for (const route of routes) {
    if (accounts.includes(route.to)) continue;
    if (matches(route.when, target)) accounts.push(route.to);
  }
  return accounts;
};

const hasEnv = (
  env: NodeJS.ProcessEnv,
  ...names: (string | undefined)[]
): boolean =>
  names.every((name) => name === undefined || (env[name] ?? "") !== "");

// 設定と環境変数から、実際に投稿できる経路を求める。
// 鍵が未設定のアカウントは無効な経路として扱い、投稿はしない。
export const resolveAccount = (
  key: string,
  account: AccountConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAccount => ({
  key,
  label: account.label ?? key,
  nostr: account.nostr !== undefined && hasEnv(env, account.nostr.hexEnv),
  bluesky:
    account.bluesky !== undefined &&
    hasEnv(env, account.bluesky.identifierEnv, account.bluesky.passwordEnv),
  concrnt:
    account.concrnt !== undefined && hasEnv(env, account.concrnt.subkeyEnv),
});

export const isConfigured = (account: ResolvedAccount): boolean =>
  account.nostr || account.bluesky || account.concrnt;

// 防災イベントの配信先を決める。
export class Router {
  constructor(
    private config: RoutingConfig,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  // 設定上の配信先。鍵の有無は問わない。
  route(target: RoutingTarget): string[] {
    return resolveRoutes(this.config.routes, target);
  }

  // 実際に投稿できる配信先だけを返す。
  deliverable(target: RoutingTarget): ResolvedAccount[] {
    return this.route(target)
      .map((key) => this.account(key))
      .filter((account): account is ResolvedAccount => account !== null)
      .filter(isConfigured);
  }

  account(key: string): ResolvedAccount | null {
    const account = this.config.accounts[key];
    if (!account) return null;
    return resolveAccount(key, account, this.env);
  }

  accounts(): ResolvedAccount[] {
    return Object.entries(this.config.accounts).map(([key, account]) =>
      resolveAccount(key, account, this.env),
    );
  }
}
