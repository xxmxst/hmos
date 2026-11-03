import type { OcrBox, OcrLine } from "../shared/types";

export interface SelectableOcrSymbol {
  index: number;
  text: string;
  box: OcrBox;
  lineIndex: number;
  wordIndex: number;
}

export interface OcrSelectionRange {
  start: number;
  end: number;
}

export function flattenOcrSymbols(lines: OcrLine[]): SelectableOcrSymbol[] {
  const symbols: SelectableOcrSymbol[] = [];
  lines.forEach((line, lineIndex) => {
    line.words.forEach((word, wordIndex) => {
      word.symbols.forEach((symbol) => {
        symbols.push({
          index: symbols.length,
          text: symbol.text,
          box: symbol.box,
          lineIndex,
          wordIndex
        });
      });
    });
  });
  return symbols;
}

export function normalizeOcrSelection(
  anchor: number | null,
  focus: number | null,
  symbolCount: number
): OcrSelectionRange | null {
  if (
    anchor === null
    || focus === null
    || !Number.isInteger(anchor)
    || !Number.isInteger(focus)
    || anchor < 0
    || focus < 0
    || anchor >= symbolCount
    || focus >= symbolCount
  ) {
    return null;
  }
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

export function selectedOcrText(
  symbols: SelectableOcrSymbol[],
  anchor: number | null,
  focus: number | null
): string {
  const range = normalizeOcrSelection(anchor, focus, symbols.length);
  if (!range) {
    return "";
  }
  let result = "";
  let previous: SelectableOcrSymbol | null = null;
  for (let index = range.start; index <= range.end; index++) {
    const symbol = symbols[index];
    if (!symbol) {
      continue;
    }
    if (previous) {
      if (symbol.lineIndex !== previous.lineIndex) {
        result += "\n";
      } else if (symbol.wordIndex !== previous.wordIndex) {
        result += wordSeparator(previous.text, symbol.text);
      }
    }
    result += symbol.text;
    previous = symbol;
  }
  return result.trim();
}

export function nearestOcrSymbolIndex(
  symbols: SelectableOcrSymbol[],
  point: { x: number; y: number },
  maximumDistance = Number.POSITIVE_INFINITY
): number | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || maximumDistance < 0) {
    return null;
  }
  let nearest: SelectableOcrSymbol | null = null;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (const symbol of symbols) {
    const right = symbol.box.x + symbol.box.width;
    const bottom = symbol.box.y + symbol.box.height;
    const dx = point.x < symbol.box.x ? symbol.box.x - point.x : point.x > right ? point.x - right : 0;
    const dy = point.y < symbol.box.y ? symbol.box.y - point.y : point.y > bottom ? point.y - bottom : 0;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < nearestDistanceSquared) {
      nearest = symbol;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest && nearestDistanceSquared <= maximumDistance * maximumDistance
    ? nearest.index
    : null;
}

function wordSeparator(previous: string, next: string): string {
  if (
    /\p{Script=Han}$/u.test(previous) && /^\p{Script=Han}/u.test(next)
    || /^[，。！？；：、）》】」』…,.!?;:%）\]]/u.test(next)
    || /[（[(《【「『￥$]$/u.test(previous)
  ) {
    return "";
  }
  return " ";
}
