// 気象庁XML をパースした素のオブジェクトを扱うための小道具。
// 同じ要素が1件のときオブジェクト、複数件のとき配列になるため揃える必要がある。

export type Node = Record<string, unknown>;

export const asArray = <T = Node>(value: unknown): T[] => {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
};

// 属性付き要素は { "#text": "3.8", "@type": "Mj" } の形になる
export const text = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const inner = (value as Node)["#text"];
    if (typeof inner === "string") return inner;
  }
  return null;
};

export const node = (value: unknown): Node | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Node)
    : null;

// { Name, Code } を持つ要素を取り出す
export const area = (value: unknown): { name: string; code: string } | null => {
  const n = node(value);
  if (!n) return null;
  const name = text(n.Name);
  const code = text(n.Code);
  if (!name || !code) return null;
  return { name, code };
};
