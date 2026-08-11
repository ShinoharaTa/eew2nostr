# 防災ステータスイベント (kind 30830) の仕様

eew2nostr が Nostr リレーに記録する防災イベントの状態を、
別プロジェクトから参照するための仕様。

- リレー: `wss://relay-jp.shino3.net`
- kind: `30830` (addressable / parameterized replaceable)
- スキーマ識別子: `jp.shino3.bosai.status/1`

## 置換の仕組み

addressable event なので、リレーは **同一 pubkey + kind + d タグ値の最新1件**
だけを保持する。防災イベントごとに d タグ (=キー) が違うため、レコード同士は
共存し、同じイベントの続報・解除は同じ d タグで上書きされる。

つまり「いま何が出ているか」はフィルタ1発で取れるが、**履歴は残らない**。
履歴が要る用途にはこのイベントは使えない。

同一秒内の連続更新で新しい方が負けないよう、`created_at` はキーごとに
厳密に単調増加させている (同値時はリレーが event id の小さい方を残すため)。

## タグ

単一文字タグはリレーでインデックスされるため、フィルタで AND 検索できる。

| タグ | 値 | 意味 |
|---|---|---|
| `d` | `weather:130010:03` など | イベントのキー。`種別:地域コード(:警報コード)` の形 |
| `t` | hazard (下表) | 災害種別 |
| `L` | `jp.shino3.bosai.status` | NIP-32 のラベル名前空間 |
| `l` | status (下表) | イベントの状態 |
| `s` | severity (下表) | 警戒レベル相当の緊急度 |

状態 (`l`) と緊急度 (`s`) を `t` に混ぜていないのは、NIP-01 のフィルタが
同一タグ内 OR / 異なるタグ間 AND で評価されるため。分けてあることで
「発表中の緊急地震速報だけ」のような絞り込みができる。

### hazard (`t` タグ / content.hazard)

| 値 | 情報 |
|---|---|
| `eew` | 緊急地震速報 |
| `earthquake` | 震度速報・震源・震度に関する情報など実測の地震情報 |
| `tsunami` | 津波警報・注意報・予報、津波情報 |
| `volcano` | 噴火警報・予報、噴火速報 |
| `weather` | 気象特別警報・警報・注意報 |
| `sediment` | 土砂災害警戒情報 |
| `flood` | 指定河川洪水予報 |
| `tornado` | 竜巻注意情報 |
| `heavy-rain` | 記録的短時間大雨情報 |
| `megaquake` | 南海トラフ地震臨時情報・北海道・三陸沖後発地震注意情報 |

### status (`l` タグ / content.status)

| 値 | 意味 |
|---|---|
| `active` | 発表中 (続報が来る可能性がある) |
| `finalized` | 最終報まで出し切った (緊急地震速報) |
| `resolved` | 解除された |
| `cancelled` | 取り消された (誤報) |

マップ表示など「いま危険な場所」を出す用途では `active` だけを拾えばよい。

### severity (`s` タグ / content.severity)

| 値 | 相当 |
|---|---|
| `emergency` | 人命に直結・即時行動 (警戒レベル5相当) |
| `warning` | 避難行動 (レベル4相当)。津波は注意報でも避難を要するためここに格上げされる |
| `advisory` | 注意 (レベル2-3相当) |
| `info` | 参考情報 |

## フィルタ例

発表中の緊急地震速報:

```json
{ "kinds": [30830], "authors": ["<pubkey>"], "#t": ["eew"], "#l": ["active"] }
```

発表中の人命に関わる情報すべて:

```json
{ "kinds": [30830], "authors": ["<pubkey>"], "#l": ["active"], "#s": ["emergency"] }
```

特定の防災イベント1件を追う (d タグ直指定):

```json
{ "kinds": [30830], "authors": ["<pubkey>"], "#d": ["weather:130010:03"] }
```

## content

JSON。スキーマは `schema` フィールドで識別する。
**フィールドの追加は後方互換とみなし版を上げない。**
削除・意味変更をする場合は `/1` の版番号を上げる。

```json
{
  "schema": "jp.shino3.bosai.status/1",
  "key": "weather:130010:03",
  "hazard": "weather",
  "kind": "forecast",
  "severity": "warning",
  "status": "active",
  "headline": "東京地方に大雨警報",
  "publishedAt": "2026-08-11T10:00:00+09:00",
  "updatedAt": "2026-08-11T10:10:00+09:00",
  "expiresAt": null,
  "area": { "name": "東京地方", "code": "130010", "type": "一次細分区域" },
  "detail": { "kind": "大雨警報", "kindCode": "03", "status": "発表", "attention": "土砂災害注意" }
}
```

| フィールド | 型 | 意味 |
|---|---|---|
| `schema` | string | スキーマ識別子 |
| `key` | string | d タグと同じ。イベントのキー |
| `hazard` | string | 災害種別 (t タグと同じ) |
| `kind` | string | `forecast` (予測・警戒) / `observed` (実測) / `action` (行動指示) |
| `severity` | string | s タグと同じ |
| `status` | string | l タグと同じ |
| `headline` | string | 電文の見出し |
| `publishedAt` | string (ISO 8601) | 初報の発表時刻 |
| `updatedAt` | string (ISO 8601) | 最新の電文の発表時刻 |
| `expiresAt` | string \| null | 有効期限。解除電文が無く時限で失効する情報 (竜巻注意情報など) で入る |
| `area` | object \| null | 対象地域。`type` は地域区分 (下表) |
| `detail` | object | 種別ごとの構造化データ (下表) |

### area.type (地域区分)

種別によって粒度が異なる。`code` の体系も区分ごとに違う。

| type | code の体系 |
|---|---|
| `震央地名` | 気象庁 震央地名コード (緊急地震速報は空文字) |
| `一次細分区域` | 先頭2桁が JIS X 0401 都道府県コード |
| `市町村等` | 同上 |
| `津波予報区` | 津波予報区コード |
| `火山` | 火山コード |
| `河川` | 河川コード |
| `対象領域` | 空文字 (南海トラフ等、固定の領域名のみ) |

### detail (種別ごと)

内部の分類器が電文から構造化した値。値が取れなかったフィールドは null。

**eew (緊急地震速報)**

| フィールド | 型 | 意味 |
|---|---|---|
| `isWarning` | boolean | 警報 (予想最大震度5弱以上) かどうか |
| `serial` | string \| null | 第n報 |
| `isLast` | boolean | 最終報かどうか |
| `forecastFrom` / `forecast` | string | 予想最大震度の下限 / 上限。`"5-"` `"5+"` の形。上限は `"over"` (程度以上) と `"不明"` がありうる |
| `forecastLg` | string \| null | 予想長周期地震動階級 |
| `magnitude` | string | マグニチュード |
| `depth` | string \| null | 深さ (km) |
| `place` | string | 震央地名 |
| `latitude` / `longitude` | number | 震央 |
| `originTime` | string \| null | 発生時刻 (ISO 8601) |

**earthquake (地震情報)**

| フィールド | 型 | 意味 |
|---|---|---|
| `maxInt` | string \| null | 最大震度 (`"5-"` 形式) |
| `maxLgInt` | string \| null | 長周期地震動階級 |
| `magnitude` / `depth` / `place` / `originTime` | | eew と同様 |
| `observed` | `{intensity, names[]}[]` | 震度ごとの観測地域 (細分区域)。強い順 |

**tsunami**: `kind` (大津波警報/津波警報/津波注意報など) / `lastKind` (前回) / `eventId`

**volcano (噴火警報・予報)**: `kind` (レベルn（…）) / `level` (number \| null) / `condition` (引上げ等) / `lastKind`

**volcano (噴火速報)**: `infoKind` = `"噴火速報"` / `eventTime` (ISO) / `municipalities` (string[])

**weather**: `kind` (大雨警報など) / `kindCode` / `status` (発表・継続・解除) / `attention` (付随の注意事項)

**sediment**: `kind` / `level` / `status` / `title` / `prefecture` ({name, code})

**flood**: `kind` (氾濫警戒情報など) / `river` / `text` (発表文)

**tornado**: `kind` / `status` / `text`

**heavy-rain**: `kind` / `text` (気象庁の発表文そのまま。地点と雨量は構造化されていない)

**megaquake**: `title` (段階込みの正式名) / `infoKind` / `stage` (調査中・巨大地震警戒など) / `stageCode` (111-190) / `text` (見出し文)

## 注意事項

- 旧形式 (schema フィールドが無く、`posts` / `deliveries` などの内部フィールドを
  含む) のイベントが移行前から残っていることがある。`schema` の有無で判別できる。
  replaceable なので同じイベントの次の更新で置き換わる
- `detail` の中身は電文由来のため、気象庁の電文仕様変更に追随して
  フィールドが増えることがある (追加は版を上げない)
- 記録は配信 (SNS投稿) と独立している。投稿されない情報 (継続で文面が
  変わらないもの等) も状態の更新としては記録される
