import { describe, expect, it } from "vitest";
import { H264StreamNormalizer } from "./h264Stream";

const start = [0, 0, 0, 1];
const sps = [0x67, 0x64, 0x00, 0x28, 1];
const pps = [0x68, 2, 3];
const changedSps = [0x67, 0x64, 0x00, 0x29, 9];
const changedPps = [0x68, 8, 9];
const idr = [0x65, 4, 5];
const delta = [0x61, 6, 7];

function annexB(...units: number[][]): Uint8Array {
  return new Uint8Array(units.flatMap((unit) => [...start, ...unit]));
}

function avcc(...units: number[][]): Uint8Array {
  return new Uint8Array(units.flatMap((unit) => [
    (unit.length >>> 24) & 0xff,
    (unit.length >>> 16) & 0xff,
    (unit.length >>> 8) & 0xff,
    unit.length & 0xff,
    ...unit
  ]));
}

describe("H264StreamNormalizer", () => {
  it("reassembles split Annex-B start codes and gates output until SPS/PPS/IDR", () => {
    const normalizer = new H264StreamNormalizer();
    const stream = annexB(sps, pps, idr, delta);

    expect(normalizer.push(stream.slice(0, 2))).toEqual([]);
    expect(normalizer.push(stream.slice(2, 11))).toEqual([]);
    const output = normalizer.push(stream.slice(11));

    expect(normalizer.state).toMatchObject({
      framing: "annex-b",
      hasSps: true,
      hasPps: true,
      hasIdr: true,
      started: true
    });
    expect(output).toHaveLength(1);
    expect(Array.from(output[0]!)).toEqual(Array.from(annexB(sps, pps, idr)));
  });

  it("detects AVCC across chunk boundaries and converts it to Annex-B", () => {
    const normalizer = new H264StreamNormalizer();
    const stream = avcc(sps, pps, idr, delta);

    expect(normalizer.push(stream.slice(0, 3))).toEqual([]);
    expect(normalizer.push(stream.slice(3, 10))).toEqual([]);
    const output = normalizer.push(stream.slice(10));

    expect(normalizer.state.framing).toBe("avcc");
    expect(output).toHaveLength(2);
    expect(Array.from(output[0]!)).toEqual(Array.from(annexB(sps, pps, idr)));
    expect(Array.from(output[1]!)).toEqual(Array.from(annexB(delta)));
  });

  it("keeps SPS/PPS for decoder recovery and requires a fresh IDR", () => {
    const normalizer = new H264StreamNormalizer();
    normalizer.push(avcc(sps, pps, idr));
    normalizer.rearm();

    expect(normalizer.state).toMatchObject({
      framing: "avcc",
      hasSps: true,
      hasPps: true,
      hasIdr: false,
      started: false
    });
    expect(normalizer.push(avcc(delta))).toEqual([]);
    const output = normalizer.push(avcc(idr));
    expect(Array.from(output[0]!)).toEqual(Array.from(annexB(sps, pps, idr)));
  });

  it("waits for a new IDR and emits only the latest configuration after SPS/PPS change", () => {
    const normalizer = new H264StreamNormalizer();
    normalizer.push(annexB(sps, pps, idr, delta));
    expect(normalizer.state.configurationVersion).toBe(2);

    const beforeIdr = normalizer.push(annexB(changedSps, changedPps, delta));
    expect(beforeIdr).toEqual([]);
    expect(normalizer.state).toMatchObject({
      hasIdr: false,
      started: false,
      configurationVersion: 4
    });

    const afterIdr = normalizer.push(annexB(idr, delta));
    expect(afterIdr).toHaveLength(1);
    expect(Array.from(afterIdr[0]!)).toEqual(Array.from(annexB(changedSps, changedPps, idr)));
    expect(normalizer.state).toMatchObject({ hasIdr: true, started: true });
  });

  it("does not change the configuration version for repeated SPS/PPS", () => {
    const normalizer = new H264StreamNormalizer();
    normalizer.push(annexB(sps, pps, idr, delta));
    normalizer.push(annexB(sps, pps, delta));

    expect(normalizer.state.configurationVersion).toBe(2);
  });

  it("rejects invalid AVCC NAL lengths", () => {
    const normalizer = new H264StreamNormalizer();
    expect(() => normalizer.push(new Uint8Array([0, 0, 0, 0]))).toThrow("AVCC NAL 长度");
  });
});
