# デプロイ

GCP の Linux インスタンスで supervisor 管理のもと常駐している。
チェックアウト先は `/home/shino3/eew2nostr`。

反映は pull 型で、`deploy/deploy.sh` が `origin/main` に追随して入れ替える。
**現在は手動実行のみ。cron は登録していない。** cron 化は任意で、
登録すると「main へのマージ = 本番反映」になる (下記)。

GitHub 側には instance への権限を何も渡さない。

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
sha は `data/deploy-failed` に記録され、main が動くまで再試行しない
(停止→失敗→復旧を繰り返して受信断を積み増さないため)。
戻しのビルドまで失敗したときだけプロセスは止まったままになる。

単一チェックアウトの in-place 更新で、リリースの世代管理はしない。
`.env` / `data/` / `log/` は gitignore されているため `git reset --hard` でも
消えない。

## 前提

### Node.js 24 以降

`engines` は `>=24`。`src/store/sqlite-store.ts` と `src/receiver/feed-cursor.ts` が
`node:sqlite` を使うため、**Node 18 や 20 では動かない**。

instance には nvm で複数の版が入っていることがある。**既定の `npm` が古い版を
指していないか必ず確認する。**

```bash
ls ~/.nvm/versions/node/
which npm && node -v
```

### supervisorctl の権限

Debian/Ubuntu の既定では supervisord の UNIX ソケットが root 専用 (`chmod=0700`)
のため、実行ユーザーから `supervisorctl` を呼べない。素のまま実行すると落ちる。

```
error: <class 'PermissionError'>, [Errno 13] Permission denied: file: .../supervisor/xmlrpc.py
```

**必要な権限は対象プログラムの stop / start だけ**なので、そこだけ許可する。

```bash
sudo visudo -f /etc/sudoers.d/eew2nostr-deploy
```

```
shino3 ALL=(root) NOPASSWD: /usr/bin/supervisorctl stop eew2nostr, /usr/bin/supervisorctl start eew2nostr
```

**`visudo` を使うこと。** 直接編集して構文を壊すと sudo 自体が使えなくなる。

cron には TTY が無いため、**`-n` 付きで通ることが条件**になる。

```bash
sudo -n /usr/bin/supervisorctl status eew2nostr
```

スクリプト側は `SUPERVISORCTL` で呼び出しごと差し替える。

```bash
SUPERVISORCTL="sudo -n /usr/bin/supervisorctl" ./deploy/deploy.sh
```

ソケットの所有者を変えて sudo 無しにする手もあるが
(`/etc/supervisor/supervisord.conf` の `[unix_http_server]` に `chown`)、
**supervisor 配下の全プログラムを操作できるようになる**ため、
他の定期ジョブと同居している場合は上の方法が狭くて安全。

## instance の初期設定

一度だけ行う。

```bash
# 1. read-only の deploy key を作り、GitHub リポジトリの
#    Settings > Deploy keys に公開鍵を登録する (Write access は付けない)
ssh-keygen -t ed25519 -f ~/.ssh/eew2nostr-deploy -N "" -C "eew2nostr-deploy"

# ~/.ssh/config
#   Host github.com-eew2nostr
#     HostName github.com
#     IdentityFile ~/.ssh/eew2nostr-deploy

# 2. クローンして .env を置く
git clone git@github.com-eew2nostr:ShinoharaTa/eew2nostr.git ~/eew2nostr
cp ~/eew2nostr/.env.sample ~/eew2nostr/.env  # 値を埋める

# 3. supervisor に登録する (プログラム名 eew2nostr)
#    /etc/supervisor/conf.d/eew2nostr.conf
#    [program:eew2nostr]
#    directory=/home/shino3/eew2nostr
#    command=npm start
#    user=shino3
#    autorestart=true
#    environment=PATH="/home/shino3/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin"

# 4. sudoers を設定する (上記「supervisorctl の権限」)
```

`environment=PATH` を入れないと supervisor が `npm` を見つけられない。
**Node 24 以降を指すこと。**

## 手動で反映する

通常はこれを使う。

```bash
cd ~/eew2nostr
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
SUPERVISORCTL="sudo -n /usr/bin/supervisorctl" ./deploy/deploy.sh
```

`origin/main` に変化が無ければ何も出力せずに終わる。

## cron で自動化する (任意)

**手で一度通してから登録する。** 通らないうちに登録すると、5分ごとに
停止→失敗を繰り返すことになる。

```bash
crontab -e
```

```cron
PATH=/home/shino3/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin
SUPERVISORCTL=sudo -n /usr/bin/supervisorctl
*/5 * * * * /usr/bin/flock -n /tmp/eew2nostr-deploy.lock /home/shino3/eew2nostr/deploy/deploy.sh >> /home/shino3/eew2nostr-deploy.log 2>&1
```

- **`PATH` は必須。** cron の既定は `/usr/bin:/bin` 程度で nvm の Node を見つけられない。
  しかも `deploy.sh` は supervisor を stop した後にビルドするため、ここで失敗すると
  ロールバックのビルドも同じ理由で失敗し、**プロセスが止まったまま復旧しない**
- ログは `/var/log/` ではなくホーム配下に置く (一般ユーザーの cron からは書けない)
- `flock -n` で、前回の実行が長引いているときに重ねて走らせない
- 変化が無い回は何も出力しないので、ログには実際のデプロイと失敗だけが残る
- supervisor のプログラム名を変えている場合は `DEPLOY_PROGRAM` で合わせる

### cron 化で変わること

**マージした瞬間に本番へ反映される** (最大5分遅れ)。受信断もその時に自動で起きる。
どのタイミングで反映するかをマージで制御することになる。

プロフィール同期 (#84) が有効な場合、**デプロイのたびに各アカウントの
プロフィールが `config/profile.yaml` の内容で上書きされる。**

## ロールバック

戻したいコミットを指定して同じスクリプトを使う。

```bash
SUPERVISORCTL="sudo -n /usr/bin/supervisorctl" ./deploy/deploy.sh <commit>
```

cron を登録している場合は次の実行で `origin/main` に追随して戻ってしまうため、
恒久的に戻すなら main 側を revert する。
