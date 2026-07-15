import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIsolatedCaptures, analyzeLogicCapture, parseLogicCaptureText } from '../src/logic-capture.js';
import { encodeSbusFrame, uartBitsForBytes } from '../src/sbus.js';

test('parses generic CSV and normalizes reverse chronological exports', () => {
  const csv = 'Time(ms),CH0,CH1,CH2\n2,0,1,0\n1,1,0,1\n0,0,1,0\n';
  const capture = parseLogicCaptureText(csv, 'reverse.csv');
  assert.deepEqual(Array.from(capture.times), [0, 0.001, 0.002]);
  assert.deepEqual(Array.from(capture.channels[0]), [0, 1, 0]);
  assert.equal(capture.fileName, 'reverse.csv');
});

test('recovers channel numbers from localized or abbreviated headers', () => {
  const csv = 'Time[s], �� 0, �� 1, �� 2\n0,0,1,0\n0.00001,1,0,1\n';
  const capture = parseLogicCaptureText(csv, 'localized.csv');
  assert.deepEqual(capture.channelNumbers, [0, 1, 2]);
  assert.deepEqual(Array.from(capture.channels[2]), [0, 1]);
});

test('analyzes synchronized SBUS input and complementary RS-422 outputs', () => {
  const frame = encodeSbusFrame([172, 300, 500, 700, 900, 992, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1811, 1000, 800]);
  const csv = makeLogicCsv(frame, 0.2e-6);
  const capture = parseLogicCaptureText(csv, 'synthetic.csv');
  const analysis = analyzeLogicCapture(capture);
  assert.ok(analysis.complementRate > 0.999);
  assert.ok(analysis.mappingRate > 0.99);
  assert.ok(Math.abs(analysis.estimatedBaudRate - 100000) < 100);
  assert.ok(Math.abs(analysis.inputBaudRate - 100000) < 100);
  assert.ok(Math.abs(analysis.outputBaudRate - 100000) < 100);
  assert.ok(analysis.baudDifferenceRate < 0.001);
  assert.equal(analysis.synchronized, true);
  assert.equal(analysis.propagationDelayAvailable, true);
  assert.equal(analysis.inputFrames.length, 1);
  assert.equal(analysis.outputFrames.length, 1);
  assert.equal(analysis.frameComparison.matchRate, 1);
  assert.ok(Math.abs(analysis.delays.median - 0.2e-6) < 1e-9);
});

test('compares isolation-safe input and output captures from separate files', () => {
  const frame = encodeSbusFrame(Array.from({ length: 16 }, (_, index) => 172 + index * 100));
  const combined = makeLogicCsv(frame, 0.2e-6);
  const lines = combined.split('\n');
  const inputCsv = ['Time(s),CH0', ...lines.slice(1).map((line) => line.split(',').slice(0, 2).join(','))].join('\n');
  const outputCsv = ['Time(s),CH1,CH2', ...lines.slice(1).map((line) => {
    const cells = line.split(',');
    return [cells[0], cells[2], cells[3]].join(',');
  })].join('\n');
  const input = parseLogicCaptureText(inputCsv, 'input.csv');
  const output = parseLogicCaptureText(outputCsv, 'output.csv');
  const analysis = analyzeIsolatedCaptures(input, output);
  assert.equal(analysis.inputFrames.length, 1);
  assert.equal(analysis.outputFrames.length, 1);
  assert.equal(analysis.frameComparison.matchRate, 1);
  assert.ok(analysis.complementRate > 0.999);
  assert.equal(analysis.propagationDelayAvailable, false);
  assert.equal(analysis.synchronized, false);
});

function makeLogicCsv(frame, delay) {
  const bitPeriod = 10e-6;
  const start = 1e-3;
  const normalBits = uartBitsForBytes(frame);
  const events = [{ time: 0, channel: -1, value: 0 }];
  let input = 0;
  let positive = 1;
  let negative = 0;
  normalBits.forEach((normal, index) => {
    const time = start + index * bitPeriod;
    const inputValue = 1 - normal;
    if (inputValue !== input) events.push({ time, channel: 0, value: inputValue });
    if (normal !== positive) events.push({ time: time + delay, channel: 1, value: normal });
    if (1 - normal !== negative) events.push({ time: time + delay, channel: 2, value: 1 - normal });
    input = inputValue;
    positive = normal;
    negative = 1 - normal;
  });
  events.push({ time: start + normalBits.length * bitPeriod + delay, channel: 1, value: 1 });
  events.push({ time: start + normalBits.length * bitPeriod + delay, channel: 2, value: 0 });
  events.sort((a, b) => a.time - b.time || a.channel - b.channel);

  const rows = ['Time(s),CH0,CH1,CH2'];
  const state = [0, 1, 0];
  let index = 0;
  while (index < events.length) {
    const time = events[index].time;
    while (index < events.length && events[index].time === time) {
      const event = events[index];
      if (event.channel >= 0) state[event.channel] = event.value;
      index += 1;
    }
    rows.push(`${time.toFixed(9)},${state.join(',')}`);
  }
  return rows.join('\n');
}
