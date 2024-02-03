import { parseEEW } from "../src/eew";
import * as fs from "fs";
import * as path from "path";

describe("parseEEW Function", () => {
  it("should correctly parse EEW data from sample.json", () => {
    const sampleDataPath = path.join(
      __dirname,
      "./sample-data/single.json"
    );
    const sampleData = JSON.parse(fs.readFileSync(sampleDataPath, "utf8"));
    console.log(JSON.stringify(sampleData));
    const result = parseEEW(sampleData);
    expect(result).toEqual(true);
  });
});
