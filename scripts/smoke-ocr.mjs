import { existsSync } from "node:fs";
import { join } from "node:path";
import bmp from "bmp-js";
import Tesseract from "tesseract.js";

const langPath = join(process.cwd(), "dist", "ocr", "tessdata");
for (const language of ["chi_sim", "eng"]) {
  const model = join(langPath, `${language}.traineddata.gz`);
  if (!existsSync(model)) {
    throw new Error(`缺少离线 OCR 模型：${model}`);
  }
}

globalThis.fetch = async () => {
  throw new Error("OCR 离线冒烟测试禁止网络访问");
};

const worker = await Tesseract.createWorker(
  ["chi_sim", "eng"],
  Tesseract.OEM.LSTM_ONLY,
  { langPath, cacheMethod: "none", gzip: true }
);
const width = 320;
const height = 80;
const pixels = Buffer.alloc(width * height * 4, 255);
const sample = bmp.encode({ data: pixels, width, height }).data;
const recognition = await worker.recognize(sample, {}, { text: true, tsv: true });
if (typeof recognition.data.tsv !== "string") {
  throw new Error("OCR 引擎未返回 TSV 识别结果");
}
await worker.terminate();
console.log("OCR 离线引擎、中英文字库和完整识别链路已就绪");
