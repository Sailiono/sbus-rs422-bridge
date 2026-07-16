import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDualModules,
  analyzeIsolatedCaptures,
  analyzeLogicCapture,
  autoDetectMapping,
  parseLogicCaptureText,
} from '../src/logic-capture.js';
import { encodeSbusFrame, uartBitsForBytes } from '../src/sbus.js';

// Build an LA2016-style CSV with arbitrary (Chinese) headers and N channels:
//   col0 = SBUS input (inverted), col1/2 = DUT-A 422+/-, col3/4 = DUT-B 422+/-
// `bPeriod` lets the second module emit at a different baud (e.g. 115200).
function buildLaCsv(frame, bBaud = 100000, repeats = 3, invertB = false) {
  const aPeriod = 10e-6;
  const bPeriod = 1 / bBaud;
  const aBits = uartBitsForBytes(frame);
  const start = 1e-3;
  const samples = new Map();
  const set = (channel, time, value) => {
    if (!samples.has(time)) samples.set(time, { 0: 0, 1: 1, 2: 0, 3: 1, 4: 0 });
    samples.get(time)[channel] = value;
  };
  for (let rep = 0; rep < repeats; rep += 1) {
    const offset = rep * aBits.length * aPeriod;
    aBits.forEach((bit, index) => {
      const time = start + offset + index * aPeriod;
      set(0, time, 1 - bit);
      set(1, time, bit);
      set(2, time, 1 - bit);
    });
    // Keep the faster/slower B path on its own time span so the two
    // modules' edges never share a sample timestamp (real hardware
    // samples each line independently).
    const bSpan = aBits.length * bPeriod;
    const bBase = start + 0.5 + rep * bSpan;
    aBits.forEach((bit, index) => {
      const time = bBase + index * bPeriod;
      const value = invertB ? 1 - bit : bit;
      set(3, time, value);
      set(4, time, 1 - value);
    });
  }
  const times = [...samples.keys()].sort((a, b) => a - b);
  const header = 'Time[s], SBUS, 自研422+, 自研422-, 淘宝422+, 淘宝422-';
  const rows = [header];
  for (const time of times) {
    const s = samples.get(time);
    rows.push(`${time.toFixed(9)},${s[0]},${s[1]},${s[2]},${s[3]},${s[4]}`);
  }
  return rows.join('\n');
}

test('parses LA2016 CSV with Chinese headers and returns column labels', () => {
  const csv = buildLaCsv(encodeSbusFrame(Array.from({ length: 16 }, (_, i) => 992 + i * 10)));
  const capture = parseLogicCaptureText(csv, 'la2016.csv');
  assert.deepEqual(capture.columnLabels, ['SBUS', '自研422+', '自研422-', '淘宝422+', '淘宝422-']);
  assert.deepEqual(capture.channelNumbers, [0, 1, 2, 3, 4]);
});

test('auto-detects SBUS input and two RS-422 module pairs', () => {
  const csv = buildLaCsv(encodeSbusFrame(Array.from({ length: 16 }, (_, i) => 992 + i * 10)));
  const capture = parseLogicCaptureText(csv, 'la2016.csv');
  const mapping = autoDetectMapping(capture);
  assert.equal(mapping.input, 0);
  assert.deepEqual(mapping.a, { pos: 1, neg: 2 });
  assert.deepEqual(mapping.b, { pos: 3, neg: 4 });
});

test('analyzes both modules with default 8E2 when both run at 100k', () => {
  const frame = encodeSbusFrame([172, 300, 500, 700, 900, 992, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1811, 1000, 800]);
  const csv = buildLaCsv(frame);
  const capture = parseLogicCaptureText(csv, 'la2016.csv');
  const result = analyzeDualModules(capture, autoDetectMapping(capture));
  assert.ok(result.dutA.frames.length >= 1);
  assert.ok(result.dutB.frames.length >= 1);
  assert.ok(Math.abs(result.dutA.baudRate - 100000) < 500);
  assert.ok(Math.abs(result.dutB.baudRate - 100000) < 500);
  assert.equal(result.frameComparison.matchRate, 1);
  assert.ok(result.frameComparison.matched >= 1);
});

test('honors per-module signal params (commercial module at 115200 / 8N1)', () => {
  const frame = encodeSbusFrame(Array.from({ length: 16 }, (_, i) => 172 + i * 100));
  const csv = buildLaCsv(frame, 115200);
  const capture = parseLogicCaptureText(csv, 'la2016.csv');
  const result = analyzeDualModules(capture, autoDetectMapping(capture), {
    a: { baud: 100000, parity: 'even', stopBits: 2 },
    b: { baud: 115200, parity: 'none', stopBits: 1 },
  });
  assert.ok(result.dutA.frames.length >= 1);
  assert.ok(Math.abs(result.dutA.baudRate - 100000) < 500);
  assert.ok(Math.abs(result.dutB.baudRate - 115200) < 1000);
  assert.ok(result.dutB.frames.length >= 1);
  assert.equal(result.frameComparison.matchRate, 1);
});

test('does not crash when a module output is not decodable as 8E2 SBUS', () => {
  // DUT-B emits with reversed polarity; should report 0 frames, not throw.
  const frame = encodeSbusFrame(Array.from({ length: 16 }, (_, i) => 172 + i * 50));
  const csv = buildLaCsv(frame, 100000, 3, true);
  const capture = parseLogicCaptureText(csv, 'la2016.csv');
  const result = analyzeDualModules(capture, autoDetectMapping(capture));
  assert.ok(result.dutA.frames.length >= 1);
  assert.equal(result.dutB.frames.length, 0);
  assert.equal(result.frameComparison.comparable, 0);
});
