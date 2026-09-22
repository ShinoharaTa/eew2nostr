#!/usr/bin/env bash
# origin/main が動いていたら更新して再起動する pull 型デプロイ。
# instance の cron から flock 付きで呼ぶ (docs/deploy.md 参照)。
#
# 使い方:
#   deploy.sh          origin/main に追随する
#   deploy.sh <ref>    指定のコミットに合わせる (ロールバック用)
set -euo pipefail

# 一度ビルドに失敗したコミットを記録し、cron の再試行のたびに
# 停止→失敗→復旧を繰り返さないようにする (main が進めば再試行する)。
# /tmp は再起動で消え、壊れたコミットのまま再試行してしまうため data/ に置く。
FAILED_MARKER="${DEPLOY_FAILED_MARKER:-data/deploy-failed}"

# supervisord のソケットは root 専用のことが多く、実行ユーザーからは
# supervisorctl を呼べない。sudo を挟めるよう呼び出しごと差し替える
# (docs/deploy.md の「supervisorctl の権限」を参照)
SUPERVISORCTL="${SUPERVISORCTL:-supervisorctl}"

# 本番インスタンスはメモリが小さく、jest が事実上止まる。停止中に走らせるため
# 受信断が無限に伸び、cron では flock で次の実行もブロックされて復旧しない。
# 検証は CI (.github/workflows/ci.yml) で行う。資源に余裕がある環境なら 1 で戻せる。
DEPLOY_RUN_TESTS="${DEPLOY_RUN_TESTS:-0}"

# 指定コミットに合わせてビルドまで済ませる。どこかで失敗したら非0を返す
build_at() {
  git reset --hard --quiet "$1" && npm ci --silent && npm run build || return 1
  [ "$DEPLOY_RUN_TESTS" = "1" ] || return 0
  npm test --silent
}

main() {
  cd "$(dirname "$(readlink -f "$0")")/.."
  mkdir -p "$(dirname "$FAILED_MARKER")"

  # supervisor に登録したプログラム名。実環境に合わせて上書きできる
  local program="${DEPLOY_PROGRAM:-eew2nostr}"
  local target="${1:-origin/main}"

  git fetch --quiet origin main

  local current sha
  current="$(git rev-parse HEAD)"
  sha="$(git rev-parse "$target")"

  if [ "$current" = "$sha" ]; then
    exit 0 # 変化なし。ログにも何も残さない
  fi

  if [ -f "$FAILED_MARKER" ] && [ "$(cat "$FAILED_MARKER")" = "$sha" ]; then
    exit 0 # 前回失敗したコミットのまま。再試行しても受信断が延びるだけ
  fi

  echo "deploy: ${current:0:7} -> ${sha:0:7} ($(date +'%Y-%m-%d %H:%M:%S'))"

  # インスタンスが小さく、ビルドと常駐プロセスを同居させられないため
  # 先に止めてリソースを空ける。ここから start までが受信断になる
  $SUPERVISORCTL stop "$program"

  # .env / data/ / log/ は gitignore されているため reset では消えない
  if build_at "$sha"; then
    rm -f "$FAILED_MARKER"
  else
    echo "deploy: build/test failed at ${sha:0:7}, rolling back to ${current:0:7}"
    echo "$sha" >"$FAILED_MARKER"
    if ! build_at "$current"; then
      echo "deploy: rollback build failed, $program is left stopped"
      exit 1
    fi
  fi

  $SUPERVISORCTL start "$program"
  echo "deploy: done $(git rev-parse --short HEAD)"
}

# git reset がこのスクリプト自身を書き換えても壊れないよう、
# 全体を関数として読み切ってから実行する (bash はファイルを逐次読みするため)
main "$@"
exit
