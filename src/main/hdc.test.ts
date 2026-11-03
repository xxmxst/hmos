import { describe, expect, it, vi } from "vitest";
import { HdcClient, parseHdcTargets, parseHdcVersion } from "./hdc";

describe("parseHdcTargets", () => {
  it("parses ready and offline devices", () => {
    const devices = parseHdcTargets(
      "6HK0125B08000006\t\tUSB\tOffline\tunknown\thdc\nCOM1\tUART\tReady\tunknown\thdc"
    );
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({
      serial: "6HK0125B08000006",
      transport: "USB",
      state: "offline"
    });
    expect(devices[1]).toMatchObject({ serial: "COM1", transport: "UART", state: "ready" });
  });

  it("treats the Connected state from HDC 3.2 as ready", () => {
    const devices = parseHdcTargets(
      "6HK0125B08000006\t\tUSB\tConnected\tlocalhost\thdc"
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      serial: "6HK0125B08000006",
      transport: "USB",
      state: "ready",
      rawState: "Connected"
    });
  });

  it("handles empty output", () => {
    expect(parseHdcTargets("[Empty]")).toEqual([]);
    expect(parseHdcTargets("")).toEqual([]);
  });
});

describe("parseHdcVersion", () => {
  it("requires HDC 3.2 or newer", () => {
    expect(parseHdcVersion("Ver: 3.0.0d").compatible).toBe(false);
    expect(parseHdcVersion("Ver: 3.2.0b").compatible).toBe(true);
    expect(parseHdcVersion("4.0.0").compatible).toBe(true);
  });
});

describe("HdcClient 文件接收", () => {
  it("从设备接收 OCR 截图", async () => {
    const client = new HdcClient("hdc.exe");
    const run = vi.spyOn(client, "run").mockResolvedValue({ stdout: "", stderr: "" });

    await client.receiveFile("SERIAL", "/data/local/tmp/ocr.jpeg", "D:\\tmp\\ocr.jpeg");

    expect(run).toHaveBeenCalledWith(
      ["-t", "SERIAL", "file", "recv", "/data/local/tmp/ocr.jpeg", "D:\\tmp\\ocr.jpeg"],
      30_000
    );
  });
});
