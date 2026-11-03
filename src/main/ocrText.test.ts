import { describe, expect, it } from "vitest";
import { parseOcrBlocks, parseOcrTsv, repairOcrSpacing } from "./ocrText";

const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

describe("parseOcrTsv", () => {
  it("按行合并文字、过滤低置信度并生成边界框", () => {
    const tsv = [
      header,
      "5\t1\t1\t1\t1\t1\t10\t20\t40\t18\t92\t鸿蒙",
      "5\t1\t1\t1\t1\t2\t52\t20\t30\t18\t89\t投屏",
      "5\t1\t1\t1\t2\t1\t12\t50\t36\t16\t20\t噪声",
      "5\t1\t1\t1\t2\t2\t50\t50\t45\t16\t80\tHello"
    ].join("\n");

    const result = parseOcrTsv(tsv, 200, 100);
    expect(result.map(({ words: _words, ...line }) => line)).toEqual([
      {
        text: "鸿蒙投屏",
        confidence: 91,
        box: { x: 10, y: 20, width: 72, height: 18 }
      },
      {
        text: "Hello",
        confidence: 80,
        box: { x: 50, y: 50, width: 45, height: 16 }
      }
    ]);
    expect(result[0]?.words).toHaveLength(2);
    expect(result[0]?.words[0]?.symbols).toHaveLength(2);
    expect(result[1]?.words[0]?.symbols).toHaveLength(5);
  });

  it("把越界坐标限制在图片内", () => {
    const tsv = [header, "5\t1\t1\t1\t1\t1\t-5\t-4\t120\t80\t90\tText"].join("\n");
    expect(parseOcrTsv(tsv, 100, 60)[0]?.box).toEqual({ x: 0, y: 0, width: 100, height: 60 });
  });
});

describe("parseOcrBlocks", () => {
  it("preserves exact symbol boxes and synthesizes boxes when symbols are missing", () => {
    const result = parseOcrBlocks([
      {
        paragraphs: [{
          lines: [{
            words: [
              {
                text: "AB",
                confidence: 96,
                bbox: { x0: 10, y0: 20, x1: 34, y1: 40 },
                symbols: [
                  { text: "A", bbox: { x0: 10, y0: 20, x1: 21, y1: 40 } },
                  { text: "B", bbox: { x0: 22, y0: 20, x1: 34, y1: 40 } }
                ]
              },
              {
                text: "CD",
                confidence: 90,
                bbox: { x0: 40, y0: 20, x1: 60, y1: 40 }
              }
            ]
          }]
        }]
      }
    ], 100, 80);

    expect(result[0]?.words[0]?.symbols).toEqual([
      { text: "A", box: { x: 10, y: 20, width: 11, height: 20 } },
      { text: "B", box: { x: 22, y: 20, width: 12, height: 20 } }
    ]);
    expect(result[0]?.words[1]?.symbols).toEqual([
      { text: "C", box: { x: 40, y: 20, width: 10, height: 20 } },
      { text: "D", box: { x: 50, y: 20, width: 10, height: 20 } }
    ]);
  });
});

describe("repairOcrSpacing", () => {
  it("清理中文与标点周围的 OCR 多余空格", () => {
    expect(repairOcrSpacing("鸿 蒙 投 屏 ， Hello world ！")).toBe("鸿蒙投屏， Hello world！");
  });
});
