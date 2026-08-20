# eew2nostr

緊急地震速報と気象庁の防災情報を受け取り、Nostr / Bluesky / Concrnt へ配信する。
あわせて防災イベントの現在の状態を Nostr リレーに記録し、他のプロジェクトから
参照できるようにしている。

## ドキュメント

| | |
|---|---|
| [docs/status-events.md](docs/status-events.md) | **リレーに記録される防災ステータスの仕様。** kind 30830・タグ設計・content スキーマ・購読例。別プロジェクトから参照する場合はここだけ読めばよい |
| [docs/telegram-coverage-plan.md](docs/telegram-coverage-plan.md) | 対応している電文の一覧と、未対応分の実装計画。気象庁の電文仕様の調査結果 |
| [docs/deploy.md](docs/deploy.md) | 本番への反映方法。instance 側の cron が main の更新を検知して入れ替える |

## 仕組み

```
dmdata (WebSocket)  ─┐
                     ├→ 分類 → ステータス記録 ─┬→ SQLite (正)
気象庁フィード (1分)  ─┘                        ├→ Nostr リレー (kind 30830 / ミラー)
                                               └→ ルーティング → 4アカウントへ配信
```

- **緊急地震速報**は気象庁の公開フィードに含まれないため dmdata から受け取る
- それ以外 (地震・津波・火山・気象警報など) は気象庁の防災情報XMLフィードを
  1分間隔でポーリングする。処理済みの位置は SQLite に保持し、再起動をまたいで
  取りこぼさない
- 配信先は `config/routing.json` で定義する。**設定に書くのは環境変数名だけで、
  鍵そのものは書かない**

### 配信先アカウント

| キー | 対象 |
|---|---|
| `eew` | 緊急地震速報 |
| `emergency` | 津波・噴火など人命に関わる速報 |
| `warning` | 各種警報 |
| `observed` | 地震情報など観測結果 |

**鍵が未設定のアカウントは投稿せず、コンソールに出すテストモードで動く。**
本番に出さずに文面だけ確認できる。

## 動かす

Node.js 24 以降が要る (`node:sqlite` を使うため)。

```bash
npm install
cp .env.sample .env   # 値を埋める
npm run dev           # ビルドして起動
```

| コマンド | |
|---|---|
| `npm run build` | TypeScript のビルド |
| `npm start` | ビルド済みのものを起動 |
| `npm test` | テスト |
| `npm run test:post` | テスト投稿 (下記) |
| `npm run lint:code` / `npm run fix:style` | Biome |

### 環境変数

| 変数 | |
|---|---|
| `EEW_TOKEN` | dmdata の API トークン |
| `HEX` | ステータスのリレーミラーと生電文投稿に使う鍵。**SNS への投稿には使わない** |
| `HEX_EEW` ほか | 配信先アカウントの鍵。`config/routing.json` の `hexEnv` などと対応する |
| `DISCORD_WEBHOOK_URL` | 起動・稼働報告・エラーの通知先 |
| `STATUS_DB_PATH` | SQLite の場所。既定 `./data/status.db` |
| `ROUTING_CONFIG_PATH` | ルーティング設定の場所。既定 `./config/routing.json` |
| `HEARTBEAT_HOURS` | 稼働報告の間隔 (時間)。0 以下で無効。既定 6 |

### テスト投稿

保存してある実電文から投稿文を組み立てて流す。本番の鍵とは分ける。

```bash
npm run test:post -- --dry-run              # 文面をコンソールに出すだけ
npm run test:post -- --type=VXSE53          # 電文種別を指定
npm run test:post -- --cleanup              # 流したテスト投稿を NIP-09 で削除
```

既定の宛先は自前のリレーのみ。`--relays=` で変えられる。

## 開発

Issue を立ててから feature ブランチを切り、PR を出す。`main` への直コミットはしない。
**PR のベースは常に `main`** にする (feature ブランチをベースにすると、
親のマージ後に子PRが main に入らない事故が起きる)。
