# 電文対応の現在地と今後の実装計画

気象庁防災情報XMLのうち、どこまで扱えていて何が残っているかをまとめる。
調査日は 2026-08-07。出典は気象庁「気象庁防災情報XML一覧表」表1.1（2026年8月6日現在）と
[配信資料に関する技術情報](https://xml.kishou.go.jp/tec_material.html) のサンプル電文。

- 表1.1: https://xml.kishou.go.jp/jmaxml_20260806_format_v1_3_hyo1_1.pdf
- サンプル: https://xml.kishou.go.jp/jmaxml_20260723_Samples.zip
- 配色指針: https://www.jma.go.jp/jma/kishou/info/colorguide/HPColorGuide_202007.pdf

---

## 1. 現在地

### 扱えている電文

| 情報 | 電文 | 分類器 | 配信先 |
|---|---|---|---|
| 緊急地震速報（警報） | VXSE43 | dmdata 経由 | eew |
| 緊急地震速報（予報） | VXSE44 | dmdata 経由 | eew |
| 震度速報 | VXSE51 | `classifyEarthquake` | observed |
| 震源に関する情報 | VXSE52 | 〃 | observed |
| 震源・震度に関する情報 | VXSE53 | 〃 | observed |
| 顕著な地震の震源要素更新のお知らせ | VXSE61 | 〃 | observed |
| 長周期地震動に関する観測情報 | VXSE62 | 〃 | observed |
| 津波警報・注意報・予報 | VTSE41 | `classifyTsunami` | emergency |
| 津波情報 | VTSE51 | 〃 | observed |
| 噴火警報・予報 | VFVO50 | `classifyVolcano` | emergency / warning |
| 気象特別警報・警報・注意報 | VPWW53 | `classifyWeather` | emergency / warning |
| 土砂災害警戒情報 | VXWW50 | `classifySediment` | emergency |
| 記録的短時間大雨情報 | VPOA50 | `classifyHeavyRain` | observed |
| 竜巻注意情報 | VPHW50 / VPHW51 | `classifyTornado` | warning |
| 指定河川洪水予報 | VXKO50 / 53 / 54 / 57 / 70 | `classifyFlood` | warning |

### 意図的に除外している電文

| 電文 | 理由 |
|---|---|
| VPWW54 | VPWW53 と同一内容の二重配信 |
| VFVO52 | 対象火山ブロックを持たず、桜島の日常的な噴火が大半 |

### 受信経路

- **dmdata (WebSocket)**: 緊急地震速報のみ。契約がそれしかない
- **気象庁フィード (ポーリング)**: `eqvol.xml` と `extra.xml` の2本。1分間隔

電文種別コードは `telegramTypeFromUrl()` が URL のファイル名から取り出し、
`src/classify/index.ts` の `CLASSIFIERS` に無いものは捨てている。

---

## 2. 課題の一覧

優先度は「命に関わるか」と「黙って落ちているか」で決めた。

| # | 課題 | 優先度 | 規模 |
|---|---|---|---|
| A | 指定河川洪水予報のコード範囲が足りない | **高** | 小 |
| B | 噴火速報が未対応 | **高** | 小 |
| C | 南海トラフ地震臨時情報・後発地震注意情報が未対応 | **高** | 中 |
| D | 沖合の津波観測に関する情報が未対応 | 中 | 中 |
| E | 線状降水帯（府県気象防災速報）が未対応 | 中 | 中 |
| F | 火山の状況に関する解説情報・降灰予報が未対応 | 低 | 中 |
| G | 令和10年度の廃止に伴う R06系への移行 | **期限あり** | 大 |

---

## 3. 課題A: 指定河川洪水予報のコード範囲

### 問題

表1.1 は **`VXKO(ii=50-89)` の40通り**と定めているが、`CLASSIFIERS` には
`VXKO50 / VXKO53 / VXKO54 / VXKO57 / VXKO70` の5つしか無い。
過去の実データで観測できたものだけを拾った形になっている。

**未登録の水系で氾濫危険情報が出ても、ログにも残らず捨てられる。**
氾濫危険情報は警戒レベル4相当（避難指示）なので、取りこぼしの影響が大きい。

同じ理由で **水位周知河川に関する情報 `VXSU(ii=50-59)`** も未対応。
ただしこちらは表1.1 に「提供時期は未定です」とあり、まだ配信されていない。

### 実装

**`src/classify/index.ts`**

`CLASSIFIERS` を「完全一致の辞書」から「前方一致も引ける」形に変える。

```ts
// 種別コードの下2桁が発表元ごとに変わる電文。範囲で受ける。
const PREFIX_CLASSIFIERS: { prefix: string; range: [number, number]; handler: Handler }[] = [
  // 指定河川洪水予報 VXKO50-89。水系ごとにコードが振られる。
  { prefix: "VXKO", range: [50, 89], handler: forecast(classifyFlood) },
];
```

`isSupported()` と `classify()` の両方で、完全一致で引けなかったときに
前方一致を試す。範囲外の下2桁は受けない（誤検知を避けるため）。

`VXKO50 / 53 / 54 / 57 / 70` の個別エントリは削除する。

### 検証

- `tests/classify.test.ts` に `VXKO50`〜`VXKO89` がすべて `isSupported` を通ること、
  `VXKO49` と `VXKO90` が通らないことを追加
- 既存の `tests/fixtures/telegrams/VXKO70.xml` が今までどおり分類できること

### 補足

水位周知河川 `VXSU(ii=50-59)` を足す場合は同じ仕組みに乗せられる。
ただし**まだ配信が始まっていない**（表1.1「提供時期は未定です」）ため、
実装は配信開始を待つ。サンプル配布物にも実物が無く、
`classifyFlood` を流用できるかは現時点で判断できない。

なお表1.1 は `VXSU`、サンプル整理表は `VXSL` と表記が割れている。
**実装前に最新の表1.1 で確認すること。**

---

## 4. 課題B: 噴火速報 (VFVO56)

### なぜ要るか

噴火が発生した事実だけを最速で伝える電文。
**噴火警報より先に出る**ことがあり、登山者にとっては噴火警報より重要。
2014年の御嶽山噴火を受けて新設された。

発表頻度は極めて低い（数年に1回）。

### 電文の構造

```xml
<Head>
  <Title>火山名　御嶽山　噴火速報</Title>
  <InfoKind>噴火速報</InfoKind>
  <InfoType>発表</InfoType>   <!-- 訂正 / 取消 もある -->
</Head>
<Body>
  <VolcanoInfo type="噴火速報">
    <Item>
      <EventTime>
        <EventDateTime dubious="頃">2014-09-27T11:53:00+09:00</EventDateTime>
      </EventTime>
      <Kind><Name>噴火</Name><Code>52</Code></Kind>
      <Areas codeType="火山名">
        <Area><Name>御嶽山</Name><Code>312</Code></Area>
      </Areas>
    </Item>
  </VolcanoInfo>
  <VolcanoInfo type="噴火速報（対象市町村等）">
    <Item>
      <Areas codeType="気象・地震・火山情報／市町村等">
        <Area><Name>長野県王滝村</Name><Code>2042900</Code></Area>
        <Area><Name>長野県木曽町</Name><Code>2043200</Code></Area>
      </Areas>
    </Item>
  </VolcanoInfo>
  <VolcanoInfoContent>
    <VolcanoHeadline>＜御嶽山で噴火が発生＞</VolcanoHeadline>
    <VolcanoActivity>御嶽山で、平成２６年９月２７日１１時５３分頃、噴火が発生しました。</VolcanoActivity>
  </VolcanoInfoContent>
</Body>
```

### 実装

**`src/classify/classifiers.ts`** に `classifyEruptionFlash` を追加する。

`classifyVolcano` は流用しない。`VolcanoInfo type` の値も
`Kind/Name` の意味（噴火警戒レベル vs 噴火の発生）も違うため。

```ts
// 噴火速報 (VFVO56)。噴火が発生した事実だけを最速で伝える。
// 噴火警報より先に出ることがあるため、警戒レベルとは独立に扱う。
export const classifyEruptionFlash = (
  report: JmaReport,
  ctx: Context,
): ClassifiedAlert[] => {
  const info = asArray(report.body.VolcanoInfo).find(
    (v) => text(v["@type"]) === "噴火速報",
  );
  // 対象火山を採る。市町村ブロックは detail に回す。
  ...
};
```

`ClassifiedAlert` への落とし込み。

| 項目 | 値 |
|---|---|
| `key` | `eruption:{火山コード}:{EventID}` |
| `hazard` | `"volcano"` |
| `kind` | `"observed"`（予測ではなく発生の事実） |
| `severity` | `"emergency"` 固定 |
| `state` | `InfoType` が `取消` なら `"cancelled"`、それ以外 `"active"` |
| `area` | 対象火山（`codeType="火山名"`） |
| `areaType` | `"火山"` |
| `detail.eventTime` | `EventDateTime` |
| `detail.municipalities` | 対象市町村の配列 |

`severity: "emergency"` 固定にするのは、噴火速報は**発表されること自体が異常事態**で、
段階を持たないため。結果として装飾は帯になり `emergency` アカウントへ流れる。

**`src/classify/index.ts`**

```ts
VFVO56: observed(classifyEruptionFlash), // 噴火速報
```

**`src/publisher/message.ts`**

`alertName()` は `hazard: "volcano"` を一律「噴火警報」にしているので、
噴火速報と区別できるようにする。`detail.kind` を見て分岐するか、
`detail` に情報種別を持たせて `alertName` で拾う。

投稿文の想定。

```
◤◢◤◢◤◢◤◢◤◢◤◢◤◢
噴火速報

🟣 御嶽山

11:53頃 噴火が発生

長野県王滝村、長野県木曽町ほか

#噴火

※テスト運用中です。
```

### 検証

- サンプル `samples/67_01_01_140927_VFVO56.xml` を
  `tests/fixtures/telegrams/VFVO56.xml` に置いてテストを書く
- 取消電文（`67_01_04_140927_VFVO56.xml`）で `state: "cancelled"` になること
- 投稿文が300グラフェムに収まること

---

## 5. 課題C: 南海トラフ地震臨時情報 / 北海道・三陸沖後発地震注意情報

### なぜ要るか

どちらも**発表されれば全国規模で防災対応が動く**情報。
南海トラフ地震臨時情報（巨大地震警戒）が出ると事前避難の対象地域が生じる。

発表頻度は極めて低い。臨時情報（調査中）は2019年の運用開始以降で数回。

### 電文の構造

**南海トラフ地震臨時情報 (VYSE50)**

```xml
<Head>
  <Title>南海トラフ地震臨時情報（巨大地震警戒）</Title>
  <InfoKind>南海トラフ地震に関連する情報</InfoKind>
  <Headline><Text>…本文…</Text></Headline>
</Head>
<Body>
  <EarthquakeInfo type="南海トラフ地震に関連する情報">
    <InfoKind>南海トラフ地震臨時情報</InfoKind>
    <InfoSerial codeType="地震関連情報番号コード">
      <Name>巨大地震警戒</Name>
      <Code>120</Code>
    </InfoSerial>
    <Text>…全文…</Text>
  </EarthquakeInfo>
</Body>
```

段階は `InfoSerial/Name` に構造化されている。**本文の解析は不要。**

サンプル `74_01_01`〜`74_01_07` から確定させたコードは次のとおり。

| `Code` | `Name` | 意味 | severity | state |
|---|---|---|---|---|
| 111 | 調査中 | 地震を起因とする調査 | `warning` | `active` |
| 112 | 調査中 | ゆっくりすべりを起因とする調査 | `warning` | `active` |
| 113 | 調査中 | その他の事象を起因とする調査 | `warning` | `active` |
| 120 | 巨大地震警戒 | 事前避難の対象 | `emergency` | `active` |
| 130 | 巨大地震注意 | 備えの再確認 | `emergency` | `active` |
| 190 | 調査終了 | 平常に戻る | `info` | `resolved` |

**名前ではなくコードで判定する。** 表記ゆれに強い。

**`InfoSerial` を持たない電文がある。** 取消の例（`74_03_01_220318_VYSE50.xml`）が
それで、`InfoType` が `取消` になる。`InfoSerial` の有無を前提にしないこと。

見出しは `Head/Title` を使う。`Control/Title` は段階を含まない
（`Head/Title` = 「南海トラフ地震臨時情報（巨大地震警戒）」、
`Control/Title` = 「南海トラフ地震臨時情報」）。

**北海道・三陸沖後発地震注意情報 (VYSE60)**

```xml
<Head>
  <Title>北海道・三陸沖後発地震注意情報</Title>
  <InfoKind>北海道・三陸沖後発地震注意情報</InfoKind>
</Head>
<Body>
  <EarthquakeInfo type="北海道・三陸沖後発地震注意情報">
    <InfoKind>北海道・三陸沖後発地震注意情報</InfoKind>
    <Text>…全文…</Text>
  </EarthquakeInfo>
</Body>
```

こちらは段階を持たない。発表されたら一段階だけ。

### 実装

**`src/classify/types.ts`**

`HazardType` に `"megaquake"` を足す。

```ts
| "megaquake" // 南海トラフ地震臨時情報・後発地震注意情報
```

`earthquake` に混ぜないのは、**震度も震源も持たない**情報であり、
`observed` アカウントの地震情報に埋もれると意味を失うため。
ルーティングで独立に扱えるようにしておく。

**`src/classify/classifiers.ts`** に `classifyMegaquake` を追加。

| 項目 | 値 |
|---|---|
| `key` | `megaquake:{EventID}` |
| `hazard` | `"megaquake"` |
| `kind` | `"forecast"` |
| `severity` | VYSE50 は `InfoSerial/Code` から、VYSE60 は `emergency` 固定 |
| `state` | 調査終了なら `"resolved"`、それ以外 `"active"` |
| `area` | `null`（全国が対象） |
| `detail.stage` | `InfoSerial/Name` |
| `detail.text` | `Headline/Text`（`Body/Text` は数千字あるので使わない） |

**本文は `Headline/Text` を使う。** `Body/Text` は解説が数千字あり投稿に載らない。

**`src/publisher/message.ts`**

- `HASHTAG` に `megaquake: "#南海トラフ"` を追加。ただし
  後発地震注意情報は南海トラフではないので、`detail` を見て
  `#南海トラフ` / `#後発地震` を出し分ける
- `alertName()` に分岐を足す
- `area` が `null` なので、地域行の代わりに「日本全国」または対象領域を出す

投稿文の想定。

```
◤◢◤◢◤◢◤◢◤◢◤◢◤◢
南海トラフ地震臨時情報（巨大地震警戒）

🟣 南海トラフ地震の想定震源域

大規模地震の発生可能性が平常時に比べて相対的に高まっています。
今後の政府や自治体などからの呼びかけ等に応じた防災対応をとってください。

#南海トラフ

※テスト運用中です。
```

`Headline/Text` が長い場合は300グラフェムに収まるよう切る。
**切る位置は句点（。）にすること。** 途中で切れると意味が変わる。

**`config/routing.json`**

`emergency` アカウントは `minSeverity: "emergency"` で拾うので設定変更は不要。
ただし専用アカウントに分けたい場合はルートを追加する。

### 検証

- サンプル `74_01_01`〜`74_01_07`（VYSE50）と `80_01_01`（VYSE60）を
  fixture に置き、段階ごとに severity が変わることを確認
- `調査終了` が `state: "resolved"` になること
- 本文が句点で切れること

---

## 6. 課題D: 沖合の津波観測に関する情報 (VTSE52)

### なぜ要るか

沿岸に到達する前の沖合観測点（GPS波浪計・水圧計）の実測値。
**津波の続報として一番速い**。到達時刻の推定も持つ。

### 電文の構造

```xml
<Body>
  <Tsunami>
    <Observation>
      <CodeDefine>
        <Type xpath="Item/Area/Code">津波予報区</Type>
        <Type xpath="Item/Station/Code">潮位観測点</Type>
      </CodeDefine>
      <Item>
        <Area><Name/><Code/></Area>
        <Station>
          <Name>岩手釜石沖</Name><Code>21090</Code>
          <Sensor>ＧＰＳ波浪計</Sensor>
          <FirstHeight>
            <ArrivalTime>2011-03-11T14:50:00+09:00</ArrivalTime>
            <Initial>引き</Initial>
          </FirstHeight>
          <MaxHeight><Condition>観測中</Condition></MaxHeight>
        </Station>
      </Item>
    </Observation>
    <Estimation>
      <Item>
        <Area><Name>岩手県</Name><Code>210</Code></Area>
        <FirstHeight>
          <ArrivalTime>2011-03-11T14:55:00+09:00</ArrivalTime>
          <Condition>早いところでは既に津波到達と推定</Condition>
        </FirstHeight>
      </Item>
    </Estimation>
  </Tsunami>
</Body>
```

### 実装

**注意すべき点が2つある。**

1. **観測点が多い。** 東日本大震災クラスでは数十点になる。
   `Estimation`（沿岸地域ごとの推定）を主に使い、
   `Observation`（観測点ごと）は最大波が確定したものだけ載せる
2. **`MaxHeight/Condition` が「観測中」のことが多い。**
   観測中は数値が無いので、高さではなく到達の事実だけを伝える

| 項目 | 値 |
|---|---|
| `key` | `tsunami-offshore:{EventID}` |
| `hazard` | `"tsunami"` |
| `kind` | `"observed"` |
| `severity` | `"warning"`（警報自体は VTSE41 が出す） |
| `area` | `Estimation` の沿岸地域 |
| `detail.stations` | 観測点と最大波 |

`hazard` を `tsunami` にするので `observed` アカウントへ流れる。
津波警報そのものは VTSE41 が `emergency` へ流すので役割が分かれる。

---

## 7. 課題E: 線状降水帯 (VPBS50 府県気象防災速報)

### なぜ要るか

**線状降水帯の発生が構造化されて入っている。** 現在は取れていない。
記録的短時間大雨情報と並んで、大雨災害の直前シグナルとして価値が高い。

extra.xml に実際に流れている（調査時点で2件）。

### 電文の構造

```xml
<Body>
  <MeteorologicalInfos type="観測実況">
    <MeteorologicalInfo>
      <DateTime>2023-09-08T10:10:00+09:00</DateTime>
      <Item>
        <Kind>
          <Property>
            <Type>気象現象の実況</Type>
            <EventPart>
              <Event type="線状降水帯">
                <EventName>線状降水帯発生</EventName>
                <Time>2023-09-08T10:10:00+09:00</Time>
              </Event>
            </EventPart>
          </Property>
        </Kind>
        <Area codeType="気象情報／府県予報区・細分区域等">
          <Name>北西部</Name><Code>120010</Code>
        </Area>
      </Item>
    </MeteorologicalInfo>
  </MeteorologicalInfos>
</Body>
```

配布サンプル7件に含まれる `Event type` は**すべて `線状降水帯`** だった
（サンプルの日付は 2026-03-24 と 2025-06-30）。他の `type` が
今後増える可能性がある。**扱う `type` はホワイトリストにする。**
知らない `type` は捨てる。何でも投稿すると量が読めない。

### 実装

| 項目 | 値 |
|---|---|
| `key` | `heavy-rain-band:{地域コード}:{EventID}` |
| `hazard` | `"heavy-rain"` |
| `kind` | `"observed"` |
| `severity` | `"emergency"`（線状降水帯は災害切迫） |
| `area` | `Area`（細分区域）。`withPrefecture()` で都道府県を補う |
| `detail.event` | `EventName` |

地域コードは `気象情報／府県予報区・細分区域等` なので
先頭2桁が都道府県コード。既存の `prefectureFromAreaCode` がそのまま使える。

---

## 8. 課題F: 火山の状況に関する解説情報 (VFVO51) / 降灰予報 (VFVO53-55)

### 火山の状況に関する解説情報

噴火警戒レベルの変更に至らない火山活動の変化を伝える。
構造は `classifyVolcano` とほぼ同じ（`Kind/Name` にレベル、`LastKind` に前回）。

```xml
<VolcanoInfo type="火山の状況に関する解説情報（対象火山）">
  <Item>
    <Kind><Name>レベル２（火口周辺規制）</Name><Code>12</Code><Condition>継続</Condition></Kind>
    <LastKind><Name>レベル２（火口周辺規制）</Name><Code>12</Code></LastKind>
    <Areas codeType="火山名"><Area><Name>草津白根山</Name><Code>350</Code></Area></Areas>
  </Item>
</VolcanoInfo>
```

`classifyVolcano` の `VolcanoInfo type` の判定を
「`対象火山` を含む」に緩めれば流用できる可能性が高い。
ただし **`Condition` が「継続」の場合、レベルは変わっていない。**
毎回投稿すると同じ内容が繰り返されるので、
`state` を見て変化があるときだけ配信するか、`warning` 以下に落とす。

### 降灰予報

定時（VFVO53）・速報（VFVO54）・詳細（VFVO55）の3種。
**定時は桜島で毎日出るため、そのまま流すと量が多すぎる。**
速報（噴火直後に出る）だけを対象にすることを検討する。

サイズが300〜3,000KBと大きく、ポーリングの負荷にも影響する。

---

## 9. 課題G: 令和10年度の廃止に伴う移行

### 何が廃止されるか

表1.1 に「令和10年度に廃止予定」と明記されているもののうち、**現在使っている3つ**。

| 廃止される電文 | 情報 | 置き換え先 |
|---|---|---|
| **VPWW53** | 気象特別警報・警報・注意報 | R06系 VPWW55〜61 |
| **VXWW50** | 土砂災害警戒情報 | VPWW56（R06 土砂） |
| **VPOA50** | 記録的短時間大雨情報 | VPBS50 府県気象防災速報（要確認） |

あわせて VPWW50 / VPWW54 / VPNO50（気象特別警報報知）も廃止予定。

**期限は令和10年度（2028年度）。移行しないと気象警報が丸ごと止まる。**

### R06系の構成

| 電文 | 対象 |
|---|---|
| VPWW55 | 大雨 |
| VPWW56 | 土砂 |
| VPWW57 | 高潮 |
| VPWW58 | 暴風 |
| VPWW59 | 波浪 |
| VPWW60 | 大雪 |
| VPWW61 | その他注意報 |
| VPWS50 | 集約通報（3,000〜5,500KB。使わない） |

現象ごとに電文が分かれる。1つの気象台が同時に複数の電文を出す。

### 構造の違い

R06系の Body は VPWW53 とほぼ同じ。

```xml
<Warning type="気象警報・注意報（一次細分区域等）">
  <Item>
    <Kind>
      <Name>レベル３大雨警報</Name>
      <Code>03</Code>
      <Status>継続</Status>
      <LastKind><Name>レベル３大雨警報</Name><Code>03</Code></LastKind>
    </Kind>
    <Area><Name>東部</Name><Code>320010</Code></Area>
    <ChangeStatus>変化無</ChangeStatus>
    <FullStatus>一部</FullStatus>
  </Item>
</Warning>
```

**違いは3点。**

1. `Warning type` が `気象警報・注意報（一次細分区域等）`（H27は `一次細分区域`）。
   現在の判定は `includes("一次細分区域")` なので**そのまま通る**
2. `Kind/Name` が **`レベル３大雨警報`** と警戒レベル付きになる。
   `severityFromName()` は `levelFromName()` を優先する作りなので**そのまま通る**
3. `ChangeStatus` / `FullStatus` が増えた。`変化無` の電文が繰り返し届くため、
   **これを見ないと同じ警報を何度も投稿する**

### 移行の手順

段階を踏む。いきなり切り替えない。

**第1段階: 並行受信して差分を測る（すぐ着手可能）**

R06系を `CLASSIFIERS` に追加するが、**配信はしない**。
`classify` だけ通して SQLite に記録し、VPWW53 の結果と突き合わせる。

- 同じ警報が両方から取れているか
- R06系だけにある / VPWW53 だけにある警報はないか
- `ChangeStatus: 変化無` がどれくらいの割合で来るか

このために `routing.json` に配信先を持たないルートを用意するか、
記録のみのフラグを `CLASSIFIERS` の `Handler` に足す。

**第2段階: `ChangeStatus` による抑制を実装**

`ChangeStatus` が `変化無` の Item は投稿対象から外す。
ただし記録（ステータス管理）には残す。

**第3段階: 切り替え**

VPWW53 と VXWW50 を `CLASSIFIERS` から外し、R06系に一本化する。
`classifySediment` は VPWW56 に統合されるため役目を終える可能性がある
（**VPWW56 の中身が土砂災害警戒情報を包含するかは第1段階で確認する**）。

### 記録的短時間大雨情報の行方

VPOA50 が廃止された後の置き換え先は表1.1 に明記が無い。
VPBS50（府県気象防災速報）に統合されると推測されるが、**未確認**。
課題E を実装するときにサンプルを全部見て確認すること。
分からなければ気象庁に問い合わせる。

---

## 10. 着手順の提案

| 順 | 課題 | 理由 |
|---|---|---|
| 1 | A 洪水予報のコード範囲 | 1ファイルの修正で塞げる。黙って落ちているのが一番まずい |
| 2 | B 噴火速報 | 命に関わる。頻度が低く実装も小さい |
| 3 | C 南海トラフ・後発地震 | 命に関わる。構造化されていて解析は容易 |
| 4 | G-1 R06系の並行受信 | 期限があるので早めに実データを溜め始める |
| 5 | E 線状降水帯 | 大雨災害の直前シグナル |
| 6 | D 沖合の津波観測 | 津波の続報として速い |
| 7 | F 火山解説・降灰予報 | 量の設計が要る |
| 8 | G-2/3 R06系への移行 | 第1段階の観測結果を見てから |

---

## 11. 共通の実装ルール

新しい電文を足すときに毎回守ること。過去に踏んだ失敗から。

- **発表文の解析はしない。** 構造化された要素から取る。
  定型文は気象庁の文面変更で壊れる
- **地域名には都道府県を補う。** 全国配信のため。
  `withPrefecture(name, code)` を使う。コードの体系が違う場合は補わない
- **`severity` は電文が持つ段階から決める。** 名前の推測に頼らない
- **投稿文は300グラフェムに収まることをテストで固定する。**
  実データの fixture を使う
- **`config/routing.json` には環境変数名だけを書く。** 鍵は書かない
- **CLI の `main()` はモジュール読み込みで走らせない。**
  純粋なロジックは別ファイルに切り出す（過去に `npm test` が実投稿した）
- 電文を追加したら `tests/fixtures/telegrams/` に実物を置き、
  `tests/message.test.ts` の `ALL_TYPES` に加える
