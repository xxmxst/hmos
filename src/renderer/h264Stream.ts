import type { VideoFraming } from "../shared/types";

const START_CODE = new Uint8Array([0, 0, 0, 1]);
const MAX_NAL_SIZE = 16 * 1024 * 1024;
const MAX_UNKNOWN_PREFIX = 64 * 1024;

interface StartCode {
  offset: number;
  length: 3 | 4;
}

export interface H264StreamState {
  framing: VideoFraming;
  hasSps: boolean;
  hasPps: boolean;
  hasIdr: boolean;
  started: boolean;
  configurationVersion: number;
}

/**
 * Turns arbitrary H.264 transport chunks into complete Annex-B NAL units.
 *
 * HOScrcpy callbacks are a continuous byte stream, so both a start code and an
 * AVCC length prefix may be split across callbacks. The incomplete tail is kept
 * here instead of being passed to the decoder as if it were a complete frame.
 */
export class H264StreamNormalizer {
  private pending = new Uint8Array();
  private framing: VideoFraming = "unknown";
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private hasIdr = false;
  private started = false;
  private configurationVersion = 0;

  get state(): H264StreamState {
    return {
      framing: this.framing,
      hasSps: this.sps !== null,
      hasPps: this.pps !== null,
      hasIdr: this.hasIdr,
      started: this.started,
      configurationVersion: this.configurationVersion
    };
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) {
      return [];
    }
    this.pending = appendBytes(this.pending, chunk);
    this.detectFraming();

    if (this.framing === "annex-b") {
      return this.consumeAnnexB();
    }
    if (this.framing === "avcc") {
      return this.consumeAvcc();
    }
    if (this.pending.byteLength > MAX_UNKNOWN_PREFIX) {
      throw new Error("无法识别 H.264 数据格式（既不是 Annex-B，也不是 AVCC）");
    }
    return [];
  }

  /** Keeps the last valid SPS/PPS and waits for a fresh IDR after decoder reset. */
  rearm(): void {
    this.pending = new Uint8Array();
    this.hasIdr = false;
    this.started = false;
  }

  reset(): void {
    this.pending = new Uint8Array();
    this.framing = "unknown";
    this.sps = null;
    this.pps = null;
    this.hasIdr = false;
    this.started = false;
    this.configurationVersion = 0;
  }

  private detectFraming(): void {
    if (this.framing !== "unknown") {
      return;
    }
    const start = findStartCodes(this.pending)[0];
    if (start && start.offset <= 3) {
      this.framing = "annex-b";
      return;
    }
    if (this.pending.byteLength < 4) {
      return;
    }
    const length = readUint32(this.pending, 0);
    if (length === 0) {
      throw new Error("无效的 AVCC NAL 长度：0");
    }
    if (length <= MAX_NAL_SIZE) {
      this.framing = "avcc";
    }
  }

  private consumeAnnexB(): Uint8Array[] {
    const starts = findStartCodes(this.pending);
    if (starts.length === 0) {
      if (this.pending.byteLength > MAX_NAL_SIZE) {
        throw new Error("H.264 NAL 单元超过 16 MiB");
      }
      return [];
    }

    if (starts[0]!.offset > 0) {
      this.pending = this.pending.slice(starts[0]!.offset);
      return this.consumeAnnexB();
    }
    if (starts.length < 2) {
      if (this.pending.byteLength > MAX_NAL_SIZE) {
        throw new Error("H.264 NAL 单元超过 16 MiB");
      }
      return [];
    }

    const output: Uint8Array[] = [];
    for (let index = 0; index < starts.length - 1; index++) {
      const current = starts[index]!;
      const next = starts[index + 1]!;
      const payload = this.pending.slice(current.offset + current.length, next.offset);
      this.processNal(payload, output);
    }
    this.pending = this.pending.slice(starts.at(-1)!.offset);
    return output;
  }

  private consumeAvcc(): Uint8Array[] {
    const output: Uint8Array[] = [];
    let offset = 0;
    while (this.pending.byteLength - offset >= 4) {
      const length = readUint32(this.pending, offset);
      if (length === 0 || length > MAX_NAL_SIZE) {
        throw new Error(`无效的 AVCC NAL 长度：${length}`);
      }
      if (this.pending.byteLength - offset - 4 < length) {
        break;
      }
      const payload = this.pending.slice(offset + 4, offset + 4 + length);
      this.processNal(payload, output);
      offset += 4 + length;
    }
    if (offset > 0) {
      this.pending = this.pending.slice(offset);
    }
    if (this.pending.byteLength > MAX_NAL_SIZE + 4) {
      throw new Error("H.264 NAL 单元超过 16 MiB");
    }
    return output;
  }

  private processNal(payload: Uint8Array, output: Uint8Array[]): void {
    if (payload.byteLength === 0) {
      return;
    }
    const type = payload[0]! & 0x1f;
    if (type === 7) {
      const isNew = this.sps === null;
      const changed = this.sps !== null && !equalBytes(this.sps, payload);
      this.sps = payload.slice();
      if (isNew || changed) {
        this.configurationVersion++;
      }
      if (changed && this.started) {
        output.length = 0;
        this.hasIdr = false;
        this.started = false;
      }
    } else if (type === 8) {
      const isNew = this.pps === null;
      const changed = this.pps !== null && !equalBytes(this.pps, payload);
      this.pps = payload.slice();
      if (isNew || changed) {
        this.configurationVersion++;
      }
      if (changed && this.started) {
        output.length = 0;
        this.hasIdr = false;
        this.started = false;
      }
    } else if (type === 5) {
      this.hasIdr = true;
    }

    if (!this.started) {
      if (type !== 5 || !this.sps || !this.pps) {
        return;
      }
      this.started = true;
      output.push(joinNalUnits([this.sps, this.pps, payload]));
      return;
    }
    output.push(joinNalUnits([payload]));
  }
}

function findStartCodes(data: Uint8Array): StartCode[] {
  const starts: StartCode[] = [];
  for (let index = 0; index + 2 < data.byteLength; index++) {
    if (data[index] !== 0 || data[index + 1] !== 0) {
      continue;
    }
    if (data[index + 2] === 1) {
      starts.push({ offset: index, length: 3 });
      index += 2;
    } else if (index + 3 < data.byteLength && data[index + 2] === 0 && data[index + 3] === 1) {
      starts.push({ offset: index, length: 4 });
      index += 3;
    }
  }
  return starts;
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    data[offset]! * 0x1000000
    + data[offset + 1]! * 0x10000
    + data[offset + 2]! * 0x100
    + data[offset + 3]!
  );
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right.slice();
  }
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function joinNalUnits(units: Uint8Array[]): Uint8Array {
  const size = units.reduce((total, unit) => total + START_CODE.byteLength + unit.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const unit of units) {
    joined.set(START_CODE, offset);
    offset += START_CODE.byteLength;
    joined.set(unit, offset);
    offset += unit.byteLength;
  }
  return joined;
}
