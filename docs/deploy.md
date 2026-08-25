# デプロイ

GCP の Linux インスタンスで supervisor 管理のもと常駐している。
反映は pull 型: instance 側の cron が `deploy/deploy.sh` を定期実行し、
`origin/main` が動いていたら更新して再起動する。

GitHub 側には instance への権限を何も渡さない。即時反映はせず、
cron 間隔 (5分) ぶん遅れて反映される。受信断が起きるのは
main が動いたときだけなので、そのタイミングはマージで制御できる。

## 仕組み

`deploy/deploy.sh` は次のことをする。

1. `git fetch` して HEAD と `origin/main` を比べる。同じなら何もせず終わる
2. supervisor のプログラムを **stop** (インスタンスが小さく、ビルドと
   常駐プロセスを同居させられないため。停止中は受信断になる)
3. `git reset --hard origin/main`
4. `npm ci` → `npm run build` → `npm test`
5. supervisor のプログラムを start

受信断は再起動の数秒ではなく **ビルド時間まるごと** (npm ci 含め数分) になる。

**ビルドかテストが失敗したら、直前のコミットに戻してビルドし直し、
旧版で起動し直す。** 壊れたコードのまま起動することはない。失敗したコミットの
sha は `/tmp/eew2nostr-deploy-failed` に記録され、main が動くまで再試行しない
(cron のたびに停止→失敗→復旧を繰り返して受信断を積み増さないため)。
戻しのビルドまで失敗したときだけプロセスは止まったままになる。
失敗は cron のログ (下記) と、成功時は起動時の Discord 通知で分かる。

単一チェックアウトの in-place 更新で、リリースの世代管理はしない。
`.env` / `data/` / `log/` は gitignore されているため `git reset --hard` でも
消えない。

## instance の初期設定

一度だけ行う。チェックアウト先は `/opt/eew2nostr` を想定 (どこでもよい)。

```bash
# 1. read-only の deploy key を作り、GitHub リポジトリの
#    Settings > Deploy keys に公開鍵を登録する (Write access は付けない)
ssh-keygen -t ed25519 -f ~/.ssh/eew2nostr-deploy -N "" -C "eew2nostr-deploy"

# ~/.ssh/config
#   Host github.com-eew2nostr
#     HostName github.com
#     IdentityFile ~/.ssh/eew2nostr-deploy

# 2. クローンして .env を置く
git clone git@github.com-eew2nostr:ShinoharaTa/eew2nostr.git /opt/eew2nostr
cp .env.sample /opt/eew2nostr/.env  # 値を埋める

# 3. supervisor に登録する (プログラム名 eew2nostr)
#    /etc/supervisor/conf.d/eew2nostr.conf
#    [program:eew2nostr]
#    directory=/opt/eew2nostr
#    command=npm start
#    autorestart=true

# 4. cron を登録する
crontab -e
```

```cron
*/5 * * * * /usr/bin/flock -n /tmp/eew2nostr-deploy.lock /opt/eew2nostr/deploy/deploy.sh >> /var/log/eew2nostr-deploy.log 2>&1
```

- `flock -n` で、前回の実行が長引いているときに重ねて走らせない
- 変化が無い回は何も出力しないので、ログには実際のデプロイと失敗だけが残る
- supervisor のプログラム名を変えている場合は環境変数 `DEPLOY_PROGRAM` で合わせる

## ロールバック

戻したいコミットを指定して同じスクリプトを使う。

```bash
/opt/eew2nostr/deploy/deploy.sh <commit>
```

ただし次の cron で `origin/main` に追随して戻ってしまうため、
恒久的に戻すなら main 側を revert する。

## 手動で反映したいとき

cron を待たずに instance で直接実行すればよい。

```bash
/opt/eew2nostr/deploy/deploy.sh
```
