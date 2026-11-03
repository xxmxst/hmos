import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  createWorker: vi.fn(),
  recognize: vi.fn(),
  logger: undefined as ((message: { status: string; progress: number }) => void) | undefined
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "D:\\temp",
    isPackaged: false
  },
  nativeImage: {
    createFromBuffer: () => ({ getSize: () => ({ width: 1264, height: 1848 }) })
  }
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  rm: mocks.rm
}));

vi.mock("tesseract.js", () => ({
  OEM: { LSTM_ONLY: 1 },
  PSM: { SPARSE_TEXT: "11" },
  createWorker: mocks.createWorker
}));

import { OcrService } from "./ocrService";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).buffer;

describe("OcrService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue(jpeg);
    mocks.recognize.mockResolvedValue({
      data: {
        tsv: [
          "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
          "5\t1\t1\t1\t1\t1\t10\t20\t80\t24\t96\t鸿蒙投屏"
        ].join("\n")
      }
    });
    mocks.createWorker.mockImplementation(async (_langs, _oem, options) => {
      mocks.logger = options.logger;
      return {
        setParameters: vi.fn().mockResolvedValue(undefined),
        recognize: mocks.recognize,
        terminate: vi.fn().mockResolvedValue(undefined)
      };
    });
  });

  it("通过 HDC 截图、拉取并清理手机和电脑临时文件", async () => {
    const hdc = {
      shell: vi.fn().mockResolvedValue(""),
      receiveFile: vi.fn().mockResolvedValue(undefined)
    };
    const service = new OcrService(hdc as never, vi.fn());

    const snapshot = await service.capture("SERIAL-1");

    expect(snapshot).toMatchObject({
      source: "device",
      mimeType: "image/jpeg",
      width: 1264,
      height: 1848
    });
    expect(hdc.receiveFile).toHaveBeenCalledOnce();
    expect(hdc.shell).toHaveBeenLastCalledWith(
      "SERIAL-1",
      expect.stringMatching(/^rm -f \/data\/local\/tmp\/hmremote-ocr-.+\.jpeg$/),
      5_000
    );
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/\.jpeg$/), { force: true });
  });

  it("高清截图失败时使用视频帧，并完成离线 OCR", async () => {
    const hdc = {
      shell: vi.fn().mockRejectedValue(new Error("snapshot_display 不可用")),
      receiveFile: vi.fn()
    };
    const progress = vi.fn();
    const service = new OcrService(hdc as never, progress);
    const snapshot = await service.capture("SERIAL-1", { image: png, mimeType: "image/png" });

    expect(snapshot.source).toBe("video");
    expect(snapshot.warning).toContain("已使用当前投屏帧");
    const result = await service.recognize(snapshot.id);

    expect(result.text).toBe("鸿蒙投屏");
    expect(result.lines[0]).toMatchObject({
      confidence: 96,
      box: { x: 10, y: 20, width: 80, height: 24 }
    });
    expect(mocks.createWorker).toHaveBeenCalledWith(
      ["chi_sim", "eng"],
      1,
      expect.objectContaining({ cacheMethod: "none", gzip: true })
    );
    expect(mocks.recognize).toHaveBeenCalledWith(
      expect.anything(),
      {},
      { text: true, tsv: true, blocks: true }
    );
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: snapshot.id }));
  });
});
