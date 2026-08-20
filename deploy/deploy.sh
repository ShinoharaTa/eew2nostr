#!/usr/bin/env bash
# origin/main が動いていたら更新して再起動する pull 型デプロイ。
# instance の cron から flock 付きで呼ぶ (docs/deploy.md 参照)。
#
# 使い方:
#   deploy.sh          origin/main に追随する
#   deploy.sh <ref>    指定のコミットに合わせる (ロールバック用)
set -euo pipefail

main() {
  cd "$(dirname "$(readlink -f "$0")")/.."

  # supervisor に登録したプログラム名。実環境に合わせて上書きできる
  local program="${DEPLOY_PROGRAM:-eew2nostr}"
  local target="${1:-origin/main}"

  git fetch --quiet origin main

  if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$target")" ]; then
    exit 0 # 変化なし。ログにも何も残さない
  fi

  echo "deploy: $(git rev-parse --short HEAD) -> $(git rev-parse --short "$target") ($(date +'%Y-%m-%d %H:%M:%S'))"

  # .env / data/ / log/ は gitignore されているため reset では消えない
  git reset --hard --quiet "$target"

  # ビルドかテストが失敗したらここで止まる (set -e)。
  # 稼働中のプロセスは古いコードのまま動き続けるので、壊れたものを取り込まない
  npm ci --silent
  npm run build
  npm test --silent

  supervisorctl restart "$program"
  echo "deploy: done $(git rev-parse --short HEAD)"
}

# git reset がこのスクリプト自身を書き換えても壊れないよう、
# 全体を関数として読み切ってから実行する (bash はファイルを逐次読みするため)
main "$@"
exit
