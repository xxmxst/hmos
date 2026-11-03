export interface NalUnit {
  type: number;
  data: Uint8Array;
}

export function findNalUnits(data: Uint8Array): NalUnit[] {
  const starts: Array<{ offset: number; prefix: number }> = [];
  for (let index = 0; index + 3 < data.length; index++) {
    if (data[index] !== 0 || data[index + 1] !== 0) {
      continue;
    }
    if (data[index + 2] === 1) {
      starts.push({ offset: index, prefix: 3 });
      index += 2;
    } else if (data[index + 2] === 0 && data[index + 3] === 1) {
      starts.push({ offset: index, prefix: 4 });
      index += 3;
    }
  }
  return starts.map((start, index) => {
    const end = starts[index + 1]?.offset ?? data.length;
    const header = start.offset + start.prefix;
    return {
      type: header < data.length ? data[header]! & 0x1f : 0,
      data: data.slice(start.offset, end)
    };
  });
}

export function codecFromSps(data: Uint8Array): string | null {
  const sps = findNalUnits(data).find((nal) => nal.type === 7);
  if (!sps) {
    return null;
  }
  const prefix = sps.data[2] === 1 ? 3 : 4;
  const profile = sps.data[prefix + 1];
  const compatibility = sps.data[prefix + 2];
  const level = sps.data[prefix + 3];
  if (profile === undefined || compatibility === undefined || level === undefined) {
    return null;
  }
  return `avc1.${hex(profile)}${hex(compatibility)}${hex(level)}`;
}

export function containsIdr(data: Uint8Array): boolean {
  return findNalUnits(data).some((nal) => nal.type === 5);
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}
