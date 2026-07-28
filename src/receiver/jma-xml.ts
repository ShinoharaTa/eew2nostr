import { XMLParser } from "fast-xml-parser";

// 気象庁防災情報XML の共通部分。Body は電文種別ごとに構造が違うため
// ここでは解釈せず、種別ごとの分類器に委ねる。
export interface JmaReport {
  control: {
    title: string;
    dateTime: string;
    status: string;
    editorialOffice: string;
    publishingOffice: string;
  };
  head: {
    title: string;
    reportDateTime: string;
    targetDateTime: string | null;
    eventId: string | null;
    infoType: string;
    serial: string | null;
    infoKind: string;
    headline: string | null;
  };
  body: Record<string, unknown>;
}

export interface JmaFeedEntry {
  // Atom の <id>。気象庁では電文 XML の URL そのものが入るため一意キーになる
  id: string;
  title: string;
  updated: string;
  url: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // jmx_eb: などの名前空間接頭辞を落として素直な形にする
  removeNSPrefix: true,
  // 電文コードや震度は "5-" のような文字列があるため数値変換しない
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

// 値が単一要素かもしれない箇所を配列に揃える
const asArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "#text" in (value as object)) {
    const inner = (value as { "#text": unknown })["#text"];
    return typeof inner === "string" ? inner : null;
  }
  return null;
};

export const parseFeed = (xml: string): JmaFeedEntry[] => {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (!feed) return [];
  return asArray(feed.entry).map((raw) => {
    const entry = raw as Record<string, unknown>;
    const link = entry.link as Record<string, unknown> | undefined;
    const id = text(entry.id) ?? "";
    return {
      id,
      title: text(entry.title) ?? "",
      updated: text(entry.updated) ?? "",
      url: (link?.["@href"] as string | undefined) ?? id,
    };
  });
};

export const parseTelegram = (xml: string): JmaReport => {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const report = parsed.Report as Record<string, unknown> | undefined;
  if (!report) throw new Error("Report element not found in telegram XML.");
  const control = (report.Control ?? {}) as Record<string, unknown>;
  const head = (report.Head ?? {}) as Record<string, unknown>;
  const headline = head.Headline as Record<string, unknown> | undefined;

  return {
    control: {
      title: text(control.Title) ?? "",
      dateTime: text(control.DateTime) ?? "",
      status: text(control.Status) ?? "",
      editorialOffice: text(control.EditorialOffice) ?? "",
      publishingOffice: text(control.PublishingOffice) ?? "",
    },
    head: {
      title: text(head.Title) ?? "",
      reportDateTime: text(head.ReportDateTime) ?? "",
      targetDateTime: text(head.TargetDateTime),
      eventId: text(head.EventID),
      infoType: text(head.InfoType) ?? "",
      serial: text(head.Serial),
      infoKind: text(head.InfoKind) ?? "",
      headline: headline ? text(headline.Text) : null,
    },
    body: (report.Body ?? {}) as Record<string, unknown>,
  };
};

// 電文 URL から種別コードを取り出す。
// 例: .../20260728084817_0_VXSE53_010000.xml -> VXSE53
export const telegramTypeFromUrl = (url: string): string | null => {
  const filename = url.split("/").pop() ?? "";
  const matched = filename.match(/^\d+_\d+_([A-Z0-9]+)_/);
  return matched ? matched[1] : null;
};
