export const SBUS_FRAME_LENGTH = 25;
export const SBUS_BAUD_RATE = 100000;
export const SBUS_BITS_PER_BYTE = 12; // 1 start + 8 data + even parity + 2 stop
export const VALID_END_BYTES = new Set([0x00, 0x04, 0x14, 0x24, 0x34]);

export function decodeSbusFrame(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  if (bytes.length !== SBUS_FRAME_LENGTH) {
    throw new RangeError(`SBUS frame must contain ${SBUS_FRAME_LENGTH} bytes`);
  }

  const channels = [];
  for (let channel = 0; channel < 16; channel += 1) {
    const bitOffset = channel * 11;
    let value = 0;
    for (let bit = 0; bit < 11; bit += 1) {
      const payloadBit = bitOffset + bit;
      const byteIndex = 1 + Math.floor(payloadBit / 8);
      const bitIndex = payloadBit % 8;
      value |= ((bytes[byteIndex] >> bitIndex) & 1) << bit;
    }
    channels.push(value);
  }

  const flags = bytes[23];
  return {
    bytes,
    channels,
    digital17: Boolean(flags & 0x01),
    digital18: Boolean(flags & 0x02),
    frameLost: Boolean(flags & 0x04),
    failsafe: Boolean(flags & 0x08),
    reservedFlags: flags & 0xf0,
    flags,
    header: bytes[0],
    footer: bytes[24],
    headerValid: bytes[0] === 0x0f,
    footerValid: VALID_END_BYTES.has(bytes[24]),
  };
}

export function encodeSbusFrame(channels, flags = {}) {
  if (!Array.isArray(channels) || channels.length !== 16) {
    throw new RangeError('channels must contain exactly 16 values');
  }
  const bytes = new Uint8Array(SBUS_FRAME_LENGTH);
  bytes[0] = 0x0f;
  channels.forEach((rawValue, channel) => {
    const value = Math.max(0, Math.min(0x7ff, Math.round(rawValue)));
    const bitOffset = channel * 11;
    for (let bit = 0; bit < 11; bit += 1) {
      if ((value >> bit) & 1) {
        const payloadBit = bitOffset + bit;
        bytes[1 + Math.floor(payloadBit / 8)] |= 1 << (payloadBit % 8);
      }
    }
  });
  bytes[23] =
    (flags.digital17 ? 0x01 : 0) |
    (flags.digital18 ? 0x02 : 0) |
    (flags.frameLost ? 0x04 : 0) |
    (flags.failsafe ? 0x08 : 0);
  bytes[24] = flags.footer ?? 0x00;
  return bytes;
}

export class SbusStreamParser {
  constructor({ onFrame, onRejected, lockFrames = 2 } = {}) {
    this.buffer = [];
    this.onFrame = onFrame;
    this.onRejected = onRejected;
    this.lockFrames = lockFrames === 1 ? 1 : 2;
    this.acquisitionBytes = 0;
    this.acquisitionCandidates = 0;
    this.rejectedBytes = 0;
    this.rejectedCandidates = 0;
    this.hasEverSynchronized = false;
    this.synchronized = false;
    this.protocol = 'unknown';
  }

  push(chunk, timestamp = performance.now()) {
    for (const byte of chunk) this.buffer.push(byte);
    const frames = [];

    while (this.buffer.length) {
      const startIndex = this.buffer.indexOf(0x0f);
      if (startIndex === -1) {
        this.reject(this.buffer.length, null, timestamp);
        this.buffer.length = 0;
        this.synchronized = false;
        break;
      }
      if (startIndex > 0) {
        this.reject(startIndex, null, timestamp);
        this.buffer.splice(0, startIndex);
        this.synchronized = false;
      }
      if (this.buffer.length < SBUS_FRAME_LENGTH) break;

      const candidate = Uint8Array.from(this.buffer.slice(0, SBUS_FRAME_LENGTH));
      if (!VALID_END_BYTES.has(candidate[24])) {
        this.reject(1, candidate, timestamp);
        this.buffer.shift();
        this.synchronized = false;
        continue;
      }

      // A payload byte can also be 0x0F and may accidentally form one
      // header/footer-looking frame when acquisition starts mid-stream.
      // Require a second consecutive frame before declaring a new lock.
      if (!this.synchronized && this.lockFrames > 1) {
        if (this.buffer.length < SBUS_FRAME_LENGTH * 2) break;
        const nextHeaderValid = this.buffer[SBUS_FRAME_LENGTH] === 0x0f;
        const nextFooterValid = VALID_END_BYTES.has(this.buffer[SBUS_FRAME_LENGTH * 2 - 1]);
        if (!nextHeaderValid || !nextFooterValid) {
          this.reject(1, candidate, timestamp);
          this.buffer.shift();
          continue;
        }
      }

      this.buffer.splice(0, SBUS_FRAME_LENGTH);
      const decoded = decodeSbusFrame(candidate);
      const frame = { ...decoded, timestamp };
      this.hasEverSynchronized = true;
      this.synchronized = true;
      if (candidate[24] !== 0x00) this.protocol = 'sbus2';
      else if (this.protocol === 'unknown') this.protocol = 'sbus';
      frames.push(frame);
      this.onFrame?.(frame);
    }
    return frames;
  }

  reset() {
    this.buffer.length = 0;
    this.acquisitionBytes = 0;
    this.acquisitionCandidates = 0;
    this.rejectedBytes = 0;
    this.rejectedCandidates = 0;
    this.hasEverSynchronized = false;
    this.synchronized = false;
    this.protocol = 'unknown';
  }

  reject(count, candidate, timestamp) {
    const phase = this.hasEverSynchronized ? 'runtime' : 'acquisition';
    if (phase === 'runtime') {
      this.rejectedBytes += count;
      if (candidate) this.rejectedCandidates += 1;
    } else {
      this.acquisitionBytes += count;
      if (candidate) this.acquisitionCandidates += 1;
    }
    this.onRejected?.({ count, candidate, timestamp, phase });
  }
}

export function uartBitsForByte(byte) {
  const data = Array.from({ length: 8 }, (_, bit) => (byte >> bit) & 1);
  const ones = data.reduce((sum, bit) => sum + bit, 0);
  const parity = ones % 2; // makes the total number of ones even
  return [0, ...data, parity, 1, 1];
}

export function uartBitsForBytes(bytes) {
  return Array.from(bytes).flatMap(uartBitsForByte);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function hexToBytes(hex) {
  const compact = hex.replace(/0x/gi, '').replace(/[^a-f\d]/gi, '');
  if (compact.length % 2 !== 0) throw new Error('Hex text must contain complete bytes');
  return Uint8Array.from(compact.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

export function calculateStats(frameRecords, rejectedBytes = 0) {
  const records = frameRecords ?? [];
  const intervals = records.slice(1).map((record, index) => record.timestamp - records[index].timestamp);
  const meanInterval = intervals.length
    ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
    : 0;
  const jitter = intervals.length > 1
    ? Math.sqrt(intervals.reduce((sum, value) => sum + (value - meanInterval) ** 2, 0) / intervals.length)
    : 0;
  return {
    frames: records.length,
    frameRate: meanInterval > 0 ? 1000 / meanInterval : 0,
    meanInterval,
    jitter,
    minInterval: intervals.length ? Math.min(...intervals) : 0,
    maxInterval: intervals.length ? Math.max(...intervals) : 0,
    lostFrames: records.filter((record) => record.frameLost).length,
    failsafeFrames: records.filter((record) => record.failsafe).length,
    rejectedBytes,
  };
}

export function compareFrameSequences(referenceRecords, measuredRecords) {
  const reference = referenceRecords.map((record) => bytesToHex(record.bytes));
  const measured = measuredRecords.map((record) => bytesToHex(record.bytes));
  if (!reference.length || !measured.length) {
    return { comparable: 0, matched: 0, mismatched: 0, matchRate: 0, offset: 0 };
  }

  const maxOffset = Math.min(100, Math.max(reference.length, measured.length) - 1);
  let best = { matched: -1, comparable: 0, offset: 0 };
  for (let offset = -maxOffset; offset <= maxOffset; offset += 1) {
    const referenceStart = Math.max(0, -offset);
    const measuredStart = Math.max(0, offset);
    const comparable = Math.min(reference.length - referenceStart, measured.length - measuredStart);
    if (comparable <= 0) continue;
    let matched = 0;
    for (let index = 0; index < comparable; index += 1) {
      if (reference[referenceStart + index] === measured[measuredStart + index]) matched += 1;
    }
    if (matched > best.matched || (matched === best.matched && comparable > best.comparable)) {
      best = { matched, comparable, offset };
    }
  }
  return {
    ...best,
    mismatched: best.comparable - best.matched,
    matchRate: best.comparable ? best.matched / best.comparable : 0,
  };
}

export function captureToJson(records, metadata = {}) {
  return {
    format: 'sbus-422-capture',
    version: 1,
    createdAt: new Date().toISOString(),
    serial: { baudRate: 100000, dataBits: 8, parity: 'even', stopBits: 2 },
    metadata,
    frames: records.map((record) => ({
      timestampMs: Number(record.timestamp.toFixed(3)),
      hex: bytesToHex(record.bytes),
    })),
  };
}

export function captureFromJson(value) {
  const capture = typeof value === 'string' ? JSON.parse(value) : value;
  if (capture?.format !== 'sbus-422-capture' || !Array.isArray(capture.frames)) {
    throw new Error('Not a supported SBUS capture file');
  }
  return capture.frames.map((frame) => {
    const bytes = hexToBytes(frame.hex);
    const decoded = decodeSbusFrame(bytes);
    return { ...decoded, timestamp: Number(frame.timestampMs) || 0 };
  });
}
