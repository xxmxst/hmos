import { describe, expect, it } from "vitest";
import type { OcrLine } from "../shared/types";
import {
  flattenOcrSymbols,
  nearestOcrSymbolIndex,
  normalizeOcrSelection,
  selectedOcrText
} from "./ocrSelection";

const lines: OcrLine[] = [
  {
    text: "鸿蒙投屏 Hello!",
    confidence: 95,
    box: { x: 10, y: 20, width: 130, height: 18 },
    words: [
      {
        text: "鸿蒙",
        confidence: 96,
        box: { x: 10, y: 20, width: 40, height: 18 },
        symbols: [
          { text: "鸿", box: { x: 10, y: 20, width: 20, height: 18 } },
          { text: "蒙", box: { x: 30, y: 20, width: 20, height: 18 } }
        ]
      },
      {
        text: "投屏",
        confidence: 94,
        box: { x: 54, y: 20, width: 40, height: 18 },
        symbols: [
          { text: "投", box: { x: 54, y: 20, width: 20, height: 18 } },
          { text: "屏", box: { x: 74, y: 20, width: 20, height: 18 } }
        ]
      },
      {
        text: "Hello",
        confidence: 95,
        box: { x: 100, y: 20, width: 35, height: 18 },
        symbols: Array.from("Hello", (text, index) => ({
          text,
          box: { x: 100 + index * 7, y: 20, width: 7, height: 18 }
        }))
      },
      {
        text: "!",
        confidence: 95,
        box: { x: 137, y: 20, width: 3, height: 18 },
        symbols: [{ text: "!", box: { x: 137, y: 20, width: 3, height: 18 } }]
      }
    ]
  },
  {
    text: "Second line",
    confidence: 92,
    box: { x: 10, y: 50, width: 90, height: 18 },
    words: [
      {
        text: "Second",
        confidence: 92,
        box: { x: 10, y: 50, width: 50, height: 18 },
        symbols: Array.from("Second", (text, index) => ({
          text,
          box: { x: 10 + index * 7, y: 50, width: 7, height: 18 }
        }))
      },
      {
        text: "line",
        confidence: 92,
        box: { x: 65, y: 50, width: 35, height: 18 },
        symbols: Array.from("line", (text, index) => ({
          text,
          box: { x: 65 + index * 8, y: 50, width: 8, height: 18 }
        }))
      }
    ]
  }
];

describe("OCR custom selection", () => {
  const symbols = flattenOcrSymbols(lines);

  it("reconstructs Chinese, English, punctuation and line breaks", () => {
    expect(selectedOcrText(symbols, 0, 9)).toBe("鸿蒙投屏 Hello!");
    expect(selectedOcrText(symbols, 9, symbols.length - 1)).toBe("!\nSecond line");
  });

  it("supports reverse selection while preserving reading order", () => {
    expect(normalizeOcrSelection(5, 2, symbols.length)).toEqual({ start: 2, end: 5 });
    expect(selectedOcrText(symbols, 5, 2)).toBe("投屏 He");
  });

  it("hits exact boxes, nearby gaps and rejects distant blank areas", () => {
    expect(nearestOcrSymbolIndex(symbols, { x: 15, y: 25 }, 2)).toBe(0);
    expect(nearestOcrSymbolIndex(symbols, { x: 52, y: 25 }, 3)).toBe(1);
    expect(nearestOcrSymbolIndex(symbols, { x: 400, y: 400 }, 12)).toBeNull();
  });
});
