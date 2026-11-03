import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn()
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "D:\\temp"
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

import { captureDeviceSnapshot } from "./deviceSnapshot";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

describe("captureDeviceSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue(jpeg);
    mocks.rm.mockResolvedValue(undefined);
  });

  it("captures an independent placeholder and cleans both temporary files", async () => {
    const hdc = {
      shell: vi.fn().mockResolvedValue(""),
      receiveFile: vi.fn().mockResolvedValue(undefined)
    };

    const snapshot = await captureDeviceSnapshot(hdc as never, "SERIAL-1", "placeholder");

    expect(snapshot).toMatchObject({
      mimeType: "image/jpeg",
      width: 1264,
      height: 1848
    });
    expect(hdc.shell).toHaveBeenNthCalledWith(
      1,
      "SERIAL-1",
      expect.stringMatching(/^snapshot_display -f \/data\/local\/tmp\/hmremote-placeholder-.+\.jpeg$/),
      20_000
    );
    expect(hdc.shell).toHaveBeenLastCalledWith(
      "SERIAL-1",
      expect.stringMatching(/^rm -f \/data\/local\/tmp\/hmremote-placeholder-.+\.jpeg$/),
      5_000
    );
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/\.jpeg$/), { force: true });
  });
});
