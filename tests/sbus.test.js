import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SbusStreamParser,
  calculateStats,
  captureFromJson,
  captureToJson,
  compareFrameSequences,
  decodeSbusFrame,
  encodeSbusFrame,
  uartBitsForByte,
} from '../src/sbus.js';

test('encodes and decodes all 16 11-bit channels', () => {
  const expected = [0, 1, 172, 500, 992, 1024, 1500, 1811, 2047, 42, 713, 999, 1200, 1600, 1900, 2012];
  const frame = encodeSbusFrame(expected, { digital17: true, frameLost: true });
  const decoded = decodeSbusFrame(frame);
  assert.deepEqual(decoded.channels, expected);
  assert.equal(decoded.digital17, true);
  assert.equal(decoded.digital18, false);
  assert.equal(decoded.frameLost, true);
  assert.equal(decoded.failsafe, false);
  assert.equal(decoded.headerValid, true);
  assert.equal(decoded.footerValid, true);
});

test('stream parser resynchronizes after noise and split chunks', () => {
  const frameA = encodeSbusFrame(Array(16).fill(300));
  const frameB = encodeSbusFrame(Array(16).fill(1700));
  const parser = new SbusStreamParser();
  assert.equal(parser.push(Uint8Array.from([0xaa, 0xbb, ...frameA.slice(0, 8)]), 10).length, 0);
  const parsed = parser.push(Uint8Array.from([...frameA.slice(8), ...frameB]), 20);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].channels[0], 300);
  assert.equal(parsed[1].channels[15], 1700);
  assert.equal(parser.acquisitionBytes, 2);
  assert.equal(parser.rejectedBytes, 0);
  assert.equal(parser.synchronized, true);
  assert.equal(parser.protocol, 'sbus');
});

test('realistic capture locks after an initial partial frame without reporting a runtime fault', () => {
  const channels = [992, 997, 192, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992, 992];
  const standardFrame = encodeSbusFrame(channels);
  const parser = new SbusStreamParser();
  const stream = Uint8Array.from([
    ...standardFrame.slice(3),
    ...Array.from({ length: 100 }, () => Array.from(standardFrame)).flat(),
  ]);
  const parsed = parser.push(stream, 10_000);

  assert.equal(parsed.length, 100);
  assert.deepEqual(parsed[0].channels, channels);
  assert.equal(parser.acquisitionBytes, 22);
  assert.equal(parser.rejectedBytes, 0);
  assert.equal(parser.rejectedCandidates, 0);
  assert.equal(parser.protocol, 'sbus');
  assert.equal(parser.synchronized, true);
});

test('stream parser reports bytes lost after lock as runtime synchronization errors', () => {
  const frame = encodeSbusFrame(Array(16).fill(992));
  const parser = new SbusStreamParser();
  assert.equal(parser.push(Uint8Array.from([...frame, ...frame]), 0).length, 2);
  assert.equal(parser.push(Uint8Array.from([0xaa, ...frame]), 10).length, 0);
  assert.equal(parser.push(frame, 20).length, 2);
  assert.equal(parser.acquisitionBytes, 0);
  assert.equal(parser.rejectedBytes, 1);
  assert.equal(parser.synchronized, true);
});

test('stream parser confirms two consecutive frames before reporting its first lock', () => {
  const falseCandidate = encodeSbusFrame(Array(16).fill(0));
  const realFrame = encodeSbusFrame(Array(16).fill(992));
  const parser = new SbusStreamParser();
  const parsed = parser.push(Uint8Array.from([
    ...falseCandidate,
    0xaa,
    ...realFrame,
    ...realFrame,
  ]), 10);

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].channels, Array(16).fill(992));
  assert.equal(parser.acquisitionBytes, 26);
  assert.equal(parser.rejectedBytes, 0);
  assert.equal(parser.synchronized, true);
});

test('even parity and 8E2 framing are reconstructed correctly', () => {
  assert.deepEqual(uartBitsForByte(0x0f), [0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1]);
  assert.equal(uartBitsForByte(0xff)[9], 0);
});

test('calculates timing and safety statistics', () => {
  const base = decodeSbusFrame(encodeSbusFrame(Array(16).fill(992)));
  const stats = calculateStats([
    { ...base, timestamp: 0 },
    { ...base, timestamp: 10, frameLost: true },
    { ...base, timestamp: 20, failsafe: true },
  ], 4);
  assert.equal(stats.frameRate, 100);
  assert.equal(stats.meanInterval, 10);
  assert.equal(stats.jitter, 0);
  assert.equal(stats.lostFrames, 1);
  assert.equal(stats.failsafeFrames, 1);
  assert.equal(stats.rejectedBytes, 4);
});

test('aligns captures and compares complete 25-byte frames', () => {
  const mk = (value, timestamp) => ({ ...decodeSbusFrame(encodeSbusFrame(Array(16).fill(value))), timestamp });
  const reference = [mk(100, 0), mk(200, 10), mk(300, 20)];
  const measured = [mk(999, 0), mk(100, 10), mk(200, 20), mk(300, 30)];
  const result = compareFrameSequences(reference, measured);
  assert.equal(result.offset, 1);
  assert.equal(result.matched, 3);
  assert.equal(result.matchRate, 1);
});

test('capture JSON round-trips without changing bytes', () => {
  const record = { ...decodeSbusFrame(encodeSbusFrame(Array(16).fill(1024))), timestamp: 12.3456 };
  const capture = captureToJson([record], { note: 'test' });
  const restored = captureFromJson(JSON.stringify(capture));
  assert.deepEqual(restored[0].channels, Array(16).fill(1024));
  assert.equal(restored[0].timestamp, 12.346);
});
