export type JsonSchema = {
  _originalId: string;
  _schema: {
    type: "eew-information";
    version: "1.0.0";
  };
  type: string;
  title: string;
  status: "通常" | "訓練" | "試験";
  infoType: "発表" | "訂正" | "遅延" | "取消";
  editorialOffice: "";
  publishingOffice: string[];
  pressDateTime: string;
  reportDateTime: string;
  targetDateTime: string | null;
  targetDateTimeDubious?: string;
  targetDuration?: string;
  validDateTime?: string;
  eventId: string | null;
  serialNo: string | null;
  infoKind: string;
  infoKindVersion: string;
  headline: string;
  body: EEW_Information;
};

/* https://dmdata.jp/docs/reference/conversion/json/schema/eew-information */
export type EEW_Information = VXSE42 | VXSE43 | VXSE44 | VXSE45;
// interface VXSE42 {
//   isLastInfo: false;
//   isCanceled: boolean;
//   text?: string;
//   comments?: _comments;
// }

interface VXSE43 {
  isLastInfo: false;
  isCanceled: boolean;
  isWarning?: boolean;
  zones?: _area;
  prefectures?: _area;
  regions?: _area;
  earthquake?: _earthquake;
  intensity?: _intensity;
  text?: string;
  comments: _comments;
}

interface VXSE44 {
  isLastInfo: boolean;
  isCanceled: boolean;
  isWarning?: boolean;
  earthquake?: _earthquake;
  intensity?: _intensity;
  text?: string;
  comments: _comments;
}

interface VXSE45 {
  isLastInfo: boolean;
  isCanceled: boolean;
  isWarning?: boolean;
  zones?: _area;
  prefectures?: _area;
  regions?: _area;
  earthquake?: _earthquake;
  intensity?: _intensity;
  text?: string;
  comments?: _comments;
}

interface _area {
  code: string;
  name: string;
  kind: {
    code: string;
    name: string;
    lastKind: {
      code: string;
      name: string;
    };
  };
}
[];

interface _earthquake {
  originTime?: string;
  arrivalTime: string;
  condition?: string;
  hypocenter: {
    code: string;
    name: string;
    coordinate: coordinate;
    depth: {
      type: "深さ";
      unit: "km";
      value: string | null;
      condition?: "ごく浅い" | "７００ｋｍ以上" | "不明";
    };
    reduce: {
      code: string;
      name: string;
    };
    landOfSea?: string;
    accuracy: {
      epicenters: [string, string];
      depth: string;
      magnitudeCalculation: string;
      numberOfMagnitudeCalculation: string;
    };
  };
  magnitude: {
    type: "マグニチュード";
    unit: "Mj" | "M";
    value: string | null;
    condition?: string;
  };
}

interface _intensity {
  forecastMaxInt: _forecastMaxInt;
  forecastMaxLgInt?: _forecastMaxLgInt;
  appendix?: {
    maxIntChange: "0" | "1" | "2";
    maxLgIntChange: "0" | "1" | "2";
    maxIntChangeReason: "0" | "1" | "2" | "3" | "4" | "9";
  };
  regions: {
    code: string;
    name: string;
    isPlum: boolean;
    isWarning: boolean;
    forecastMaxInt: _forecastMaxInt;
    forecastMaxLgInt?: _forecastMaxLgInt;
    kind: {
      code: string;
      name: string;
    };
    condition?: string;
    arrivalTime?: string;
  };
}

interface _comments {
  free?: string;
  warning?: {
    text: string;
    codes: string[];
  };
}

interface _forecastMaxInt {
  from: "0" | "1" | "2" | "3" | "4" | "5-" | "5+" | "6-" | "6+" | "7" | "不明";
  to:
    | "0"
    | "1"
    | "2"
    | "3"
    | "4"
    | "5-"
    | "5+"
    | "6-"
    | "6+"
    | "7"
    | "over"
    | "不明";
}

interface _forecastMaxLgInt {
  from: "0" | "1" | "2" | "3" | "4" | "不明";
  to: "0" | "1" | "2" | "3" | "4" | "over" | "不明";
}
