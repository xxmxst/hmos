import type { OcrBox, OcrLine, OcrSymbol, OcrWord } from "../shared/types";

const MIN_WORD_CONFIDENCE = 30;
const MAX_LINES = 1_000;
const MAX_SYMBOLS = 10_000;

interface InputBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface InputSymbol {
  text: string;
  bbox: InputBox;
}

interface InputWord {
  text: string;
  confidence: number;
  bbox: InputBox;
  symbols?: InputSymbol[];
}

interface InputLine {
  words?: InputWord[];
}

interface InputParagraph {
  lines?: InputLine[];
}

export interface OcrBlockInput {
  paragraphs?: InputParagraph[];
}

interface MutableLine {
  words: OcrWord[];
  confidenceTotal: number;
  confidenceWeight: number;
}

export function parseOcrBlocks(
  blocks: readonly OcrBlockInput[] | null | undefined,
  imageWidth: number,
  imageHeight: number
): OcrLine[] {
  validateImageDimensions(imageWidth, imageHeight);
  if (!blocks) {
    return [];
  }
  const lines: OcrLine[] = [];
  let symbolCount = 0;
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const inputLine of paragraph.lines ?? []) {
        if (lines.length >= MAX_LINES || symbolCount >= MAX_SYMBOLS) {
          return sortLines(lines);
        }
        const words: OcrWord[] = [];
        for (const inputWord of inputLine.words ?? []) {
          const word = parseBlockWord(inputWord, imageWidth, imageHeight);
          if (!word || symbolCount + word.symbols.length > MAX_SYMBOLS) {
            continue;
          }
          words.push(word);
          symbolCount += word.symbols.length;
        }
        const line = buildLine(words);
        if (line) {
          lines.push(line);
        }
      }
    }
  }
  return sortLines(lines);
}

export function parseOcrTsv(tsv: string, imageWidth: number, imageHeight: number): OcrLine[] {
  validateImageDimensions(imageWidth, imageHeight);
  const grouped = new Map<string, MutableLine>();
  let symbolCount = 0;
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    if (!row.trim() || symbolCount >= MAX_SYMBOLS) {
      continue;
    }
    const columns = row.split("\t");
    if (columns.length < 12 || columns[0] !== "5") {
      continue;
    }
    const confidence = Number(columns[10]);
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    const text = columns.slice(11).join("\t").trim();
    const box = clampBox({ x: left, y: top, width, height }, imageWidth, imageHeight);
    if (!text || !Number.isFinite(confidence) || confidence < MIN_WORD_CONFIDENCE || !box) {
      continue;
    }
    const symbols = synthesizeSymbols(text, box);
    if (symbols.length === 0 || symbolCount + symbols.length > MAX_SYMBOLS) {
      continue;
    }
    symbolCount += symbols.length;
    const word: OcrWord = { text, confidence: Math.round(confidence), box, symbols };
    const key = columns.slice(1, 5).join(":");
    const current = grouped.get(key) ?? { words: [], confidenceTotal: 0, confidenceWeight: 0 };
    current.words.push(word);
    current.confidenceTotal += confidence * text.length;
    current.confidenceWeight += text.length;
    grouped.set(key, current);
  }

  return sortLines(
    [...grouped.values()]
      .map((line) => buildLine(line.words, line.confidenceTotal, line.confidenceWeight))
      .filter((line): line is OcrLine => Boolean(line))
      .slice(0, MAX_LINES)
  );
}

export function repairOcrSpacing(text: string): string {
  return text
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/\s+([，。！？；：、）》】」』…,.!?;:%）\]])/gu, "$1")
    .replace(/([（[(《【「『￥$])\s+/gu, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseBlockWord(
  input: InputWord,
  imageWidth: number,
  imageHeight: number
): OcrWord | null {
  const text = input.text?.trim();
  const confidence = Number(input.confidence);
  const box = clampInputBox(input.bbox, imageWidth, imageHeight);
  if (!text || !Number.isFinite(confidence) || confidence < MIN_WORD_CONFIDENCE || !box) {
    return null;
  }
  let symbols = (input.symbols ?? [])
    .map((symbol): OcrSymbol | null => {
      const symbolText = symbol.text?.trim();
      const symbolBox = clampInputBox(symbol.bbox, imageWidth, imageHeight);
      return symbolText && symbolBox ? { text: symbolText, box: symbolBox } : null;
    })
    .filter((symbol): symbol is OcrSymbol => Boolean(symbol));
  if (symbols.map((symbol) => symbol.text).join("") !== text.replace(/\s+/g, "")) {
    symbols = synthesizeSymbols(text, box);
  }
  return symbols.length > 0
    ? { text, confidence: Math.round(confidence), box, symbols }
    : null;
}

function synthesizeSymbols(text: string, box: OcrBox): OcrSymbol[] {
  const characters = Array.from(text.replace(/\s+/g, ""));
  if (characters.length === 0) {
    return [];
  }
  return characters.map((character, index) => {
    const left = box.x + box.width * index / characters.length;
    const right = box.x + box.width * (index + 1) / characters.length;
    return {
      text: character,
      box: {
        x: left,
        y: box.y,
        width: right - left,
        height: box.height
      }
    };
  });
}

function buildLine(
  inputWords: OcrWord[],
  confidenceTotal?: number,
  confidenceWeight?: number
): OcrLine | null {
  const words = [...inputWords].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
  if (words.length === 0) {
    return null;
  }
  const left = Math.min(...words.map((word) => word.box.x));
  const top = Math.min(...words.map((word) => word.box.y));
  const right = Math.max(...words.map((word) => word.box.x + word.box.width));
  const bottom = Math.max(...words.map((word) => word.box.y + word.box.height));
  const total = confidenceTotal
    ?? words.reduce((sum, word) => sum + word.confidence * word.text.length, 0);
  const weight = confidenceWeight
    ?? words.reduce((sum, word) => sum + word.text.length, 0);
  return {
    text: repairOcrSpacing(words.map((word) => word.text).join(" ")),
    confidence: Math.round(total / Math.max(1, weight)),
    box: { x: left, y: top, width: right - left, height: bottom - top },
    words
  };
}

function clampInputBox(box: InputBox, imageWidth: number, imageHeight: number): OcrBox | null {
  if (!box) {
    return null;
  }
  return clampBox(
    { x: Number(box.x0), y: Number(box.y0), width: Number(box.x1) - Number(box.x0), height: Number(box.y1) - Number(box.y0) },
    imageWidth,
    imageHeight
  );
}

function clampBox(box: OcrBox, imageWidth: number, imageHeight: number): OcrBox | null {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const left = clamp(box.x, 0, imageWidth);
  const top = clamp(box.y, 0, imageHeight);
  const right = clamp(box.x + box.width, 0, imageWidth);
  const bottom = clamp(box.y + box.height, 0, imageHeight);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

function sortLines(lines: OcrLine[]): OcrLine[] {
  return lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x).slice(0, MAX_LINES);
}

function validateImageDimensions(imageWidth: number, imageHeight: number): void {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("OCR 图片尺寸无效");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
