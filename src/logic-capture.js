import { SbusStreamParser, calculateStats, compareFrameSequences } from './sbus.js';

const DEFAULT_BIT_PERIOD = 10e-6;
const MAX_ROWS = 2_000_000;

export function parseLogicCaptureText(text, fileName = 'logic-capture.csv') {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  const lines = normalized.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (!lines.length) throw new Error('文件中没有可解析的数据行');

  let headerIndex = lines.findIndex((line) => /(?:time|时间)/i.test(line) && /(?:ch(?:annel)?\s*\d+|通道\s*\d+)/i.test(line));
  if (headerIndex < 0) headerIndex = looksNumericRow(lines[0]) ? -1 : 0;
  const delimiter = detectDelimiter(lines[Math.max(0, headerIndex)]);
  const header = headerIndex >= 0 ? splitLine(lines[headerIndex], delimiter).map(cleanCell) : [];
  const columns = findColumns(header, splitLine(lines[Math.max(0, startLineForProbe(headerIndex, lines))], delimiter).length);
  const timeScale = findTimeScale(header[columns.time] ?? 'Time(s)');
  const startLine = headerIndex + 1;
  const rows = [];

  for (let index = startLine; index < lines.length; index += 1) {
    const cells = splitLine(lines[index], delimiter).map(cleanCell);
    const time = Number.parseFloat(cells[columns.time]);
    const states = [];
    let valid = Number.isFinite(time);
    for (const channel of columns.channels) {
      states[channel.number] = parseLogic(cells[channel.index]);
      if (states[channel.number] == null) valid = false;
    }
    if (!valid) continue;
    rows.push({ time: time * timeScale, states });
    if (rows.length > MAX_ROWS) throw new Error(`数据超过 ${MAX_ROWS.toLocaleString()} 行，请缩小逻辑分析仪的导出时间范围`);
  }
  if (rows.length < 2) throw new Error('至少需要两行包含 Time、CH0、CH1、CH2 的数字数据');

  const direction = monotonicDirection(rows);
  if (direction < 0) rows.reverse();
  else if (direction === 0) rows.sort((a, b) => a.time - b.time);

  const firstTime = rows[0].time;
  const times = [];
  const states = [];
  for (const row of rows) {
    const relativeTime = row.time - firstTime;
    const last = states.at(-1);
    if (times.length && Math.abs(relativeTime - times.at(-1)) < Number.EPSILON) {
      states[states.length - 1] = row.states;
    } else if (!last || columns.channels.some(({ number }) => last[number] !== row.states[number])) {
      times.push(relativeTime);
      states.push(row.states);
    }
  }
  if (times.length < 2) throw new Error('三个通道在导出区间内没有检测到逻辑变化');

  return {
    format: 'logic-capture-text-v1',
    fileName,
    sourceRows: rows.length,
    times: Float64Array.from(times),
    channelNumbers: columns.channels.map(({ number }) => number),
    channels: Object.fromEntries(columns.channels.map(({ number }) => [number, Uint8Array.from(states, (state) => state[number])])),
    duration: times.at(-1),
    originalTimeOffset: firstTime,
  };
}

export function analyzeLogicCapture(capture, bitPeriodHint = DEFAULT_BIT_PERIOD) {
  requireChannels(capture, [0, 1, 2], '同步分析');
  const { times, channels } = capture;
  let totalDuration = 0;
  let complementaryDuration = 0;
  let directDuration = 0;
  let reverseDuration = 0;
  for (let index = 0; index < times.length - 1; index += 1) {
    const duration = times[index + 1] - times[index];
    if (duration <= 0) continue;
    const [input, positive, negative] = [0, 1, 2].map((channel) => channels[channel][index]);
    totalDuration += duration;
    if (positive !== negative) complementaryDuration += duration;
    if (positive === 1 - input && negative === input) directDuration += duration;
    if (negative === 1 - input && positive === input) reverseDuration += duration;
  }

  const positiveIsNormal = directDuration >= reverseDuration;
  const normalOutputChannel = positiveIsNormal ? 1 : 2;
  const mappingDuration = Math.max(directDuration, reverseDuration);
  const inputBitPeriod = estimateBitPeriod(capture, 0, bitPeriodHint);
  const outputBitPeriod = estimateBitPeriod(capture, normalOutputChannel, bitPeriodHint);
  const inputUart = decodeUart8E2(capture, 0, { invert: true, bitPeriod: inputBitPeriod });
  const outputUart = decodeUart8E2(capture, normalOutputChannel, { invert: false, bitPeriod: outputBitPeriod });
  const inputFrames = decodeSbusFrames(inputUart.validBytes);
  const outputFrames = decodeSbusFrames(outputUart.validBytes);
  const frameComparison = compareFrameSequences(inputFrames, outputFrames);
  const delays = calculatePropagationDelays(capture, normalOutputChannel, positiveIsNormal, Math.min(inputBitPeriod, outputBitPeriod));

  return {
    synchronized: true,
    propagationDelayAvailable: true,
    positiveIsNormal,
    normalOutputChannel,
    complementRate: totalDuration ? complementaryDuration / totalDuration : 0,
    mappingRate: totalDuration ? mappingDuration / totalDuration : 0,
    inputBitPeriod,
    outputBitPeriod,
    inputBaudRate: inputBitPeriod ? 1 / inputBitPeriod : 0,
    outputBaudRate: outputBitPeriod ? 1 / outputBitPeriod : 0,
    baudDifferenceRate: inputBitPeriod && outputBitPeriod ? Math.abs(1 / inputBitPeriod - 1 / outputBitPeriod) / (1 / inputBitPeriod) : 0,
    estimatedBitPeriod: outputBitPeriod,
    estimatedBaudRate: outputBitPeriod ? 1 / outputBitPeriod : 0,
    inputUart,
    outputUart,
    inputFrames,
    outputFrames,
    frameComparison,
    delays,
  };
}

export function analyzeIsolatedCaptures(inputCapture, outputCapture, bitPeriodHint = DEFAULT_BIT_PERIOD) {
  requireChannels(inputCapture, [0], '输入侧捕获');
  requireChannels(outputCapture, [1, 2], '输出侧捕获');
  const inputBitPeriod = estimateBitPeriod(inputCapture, 0, bitPeriodHint);
  const inputUart = decodeUart8E2(inputCapture, 0, { invert: true, bitPeriod: inputBitPeriod });
  const inputFrames = decodeSbusFrames(inputUart.validBytes);
  const outputCandidates = [1, 2].map((channel) => {
    const bitPeriod = estimateBitPeriod(outputCapture, channel, bitPeriodHint);
    const uart = decodeUart8E2(outputCapture, channel, { invert: false, bitPeriod });
    const frames = decodeSbusFrames(uart.validBytes);
    return { channel, bitPeriod, uart, frames };
  });
  outputCandidates.sort((a, b) =>
    b.frames.length - a.frames.length ||
    b.uart.validBytes.length - a.uart.validBytes.length ||
    a.uart.invalidFrames.length - b.uart.invalidFrames.length);
  const output = outputCandidates[0];
  const frameComparison = compareFrameSequences(inputFrames, output.frames);
  return {
    isolated: true,
    synchronized: false,
    normalOutputChannel: output.channel,
    positiveIsNormal: output.channel === 1,
    complementRate: calculateComplementRate(outputCapture, 1, 2),
    inputBitPeriod,
    outputBitPeriod: output.bitPeriod,
    inputBaudRate: inputBitPeriod ? 1 / inputBitPeriod : 0,
    outputBaudRate: output.bitPeriod ? 1 / output.bitPeriod : 0,
    baudDifferenceRate: inputBitPeriod && output.bitPeriod ? Math.abs(1 / inputBitPeriod - 1 / output.bitPeriod) / (1 / inputBitPeriod) : 0,
    inputUart,
    outputUart: output.uart,
    inputFrames,
    outputFrames: output.frames,
    inputStats: calculateStats(inputFrames),
    outputStats: calculateStats(output.frames),
    frameComparison,
    polarity: output.channel === 1 ? 'CH1=UART, CH2=UART反相' : 'CH2=UART, CH1=UART反相',
    propagationDelayAvailable: false,
  };
}

export function decodeUart8E2(capture, channel, { invert = false, bitPeriod = DEFAULT_BIT_PERIOD } = {}) {
  const edges = getEdges(capture, channel, invert);
  const validBytes = [];
  const invalidFrames = [];
  let busyUntil = -Infinity;
  for (const edge of edges) {
    if (edge.state !== 0 || edge.time < busyUntil) continue;
    const data = [];
    for (let bit = 0; bit < 8; bit += 1) {
      data.push(getStateAt(capture, edge.time + (1.5 + bit) * bitPeriod, channel, invert));
    }
    const parity = getStateAt(capture, edge.time + 9.5 * bitPeriod, channel, invert);
    const stop1 = getStateAt(capture, edge.time + 10.5 * bitPeriod, channel, invert);
    const stop2 = getStateAt(capture, edge.time + 11.5 * bitPeriod, channel, invert);
    const parityValid = (data.reduce((sum, value) => sum + value, 0) + parity) % 2 === 0;
    const stopValid = stop1 === 1 && stop2 === 1;
    const byte = data.reduce((value, bit, index) => value | (bit << index), 0);
    const item = { byte, startTime: edge.time, parityValid, stopValid };
    if (parityValid && stopValid) validBytes.push(item);
    else invalidFrames.push(item);
    busyUntil = edge.time + 11.8 * bitPeriod;
  }
  return { validBytes, invalidFrames, totalCharacters: validBytes.length + invalidFrames.length };
}

export function getStateAt(capture, time, channel, invert = false) {
  const index = findIndexAtOrBefore(capture.times, time);
  const value = capture.channels[channel][Math.max(0, index)];
  return invert ? 1 - value : value;
}

export function findIndexAtOrBefore(times, value) {
  let low = 0;
  let high = times.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= value) low = mid + 1;
    else high = mid - 1;
  }
  return high;
}

function decodeSbusFrames(byteEvents) {
  // The logic-analyzer import is a finite, already UART-validated capture and
  // may intentionally contain only one SBUS frame, so no streaming lock delay
  // is needed here.
  const parser = new SbusStreamParser({ lockFrames: 1 });
  const frames = [];
  for (const event of byteEvents) {
    frames.push(...parser.push(Uint8Array.of(event.byte), event.startTime * 1000));
  }
  return frames;
}

function calculatePropagationDelays(capture, outputChannel, positiveIsNormal, bitPeriod) {
  const inputEdges = getEdges(capture, 0, false);
  const outputEdges = getEdges(capture, outputChannel, false);
  const values = [];
  let outputIndex = 0;
  const tolerance = Math.min(bitPeriod * 0.45, 5e-6);
  for (const inputEdge of inputEdges) {
    const expectedOutputState = 1 - inputEdge.state;
    while (outputIndex < outputEdges.length && outputEdges[outputIndex].time < inputEdge.time - tolerance) outputIndex += 1;
    let best = null;
    for (let index = outputIndex; index < Math.min(outputIndex + 4, outputEdges.length); index += 1) {
      const candidate = outputEdges[index];
      if (candidate.time > inputEdge.time + tolerance) break;
      if (candidate.state !== expectedOutputState) continue;
      if (!best || Math.abs(candidate.time - inputEdge.time) < Math.abs(best.time - inputEdge.time)) best = candidate;
    }
    if (best) values.push(best.time - inputEdge.time);
  }
  values.sort((a, b) => a - b);
  const absolute = values.map(Math.abs).sort((a, b) => a - b);
  return {
    samples: values.length,
    median: percentile(values, 0.5),
    p95Absolute: percentile(absolute, 0.95),
    min: values[0] ?? 0,
    max: values.at(-1) ?? 0,
    polarity: positiveIsNormal ? 'CH1=UART, CH2=UART反相' : 'CH2=UART, CH1=UART反相',
  };
}

function estimateBitPeriod(capture, channel, hint) {
  const edges = getEdges(capture, channel, false);
  const candidates = [];
  for (let index = 1; index < edges.length; index += 1) {
    const duration = edges[index].time - edges[index - 1].time;
    if (duration < hint * 0.4 || duration > hint * 30) continue;
    const bits = Math.max(1, Math.round(duration / hint));
    const candidate = duration / bits;
    if (Math.abs(candidate - hint) <= hint * 0.2) candidates.push(candidate);
  }
  candidates.sort((a, b) => a - b);
  return percentile(candidates, 0.5) || hint;
}

function getEdges(capture, channel, invert = false) {
  const values = capture.channels[channel];
  const edges = [];
  let previous = invert ? 1 - values[0] : values[0];
  for (let index = 1; index < values.length; index += 1) {
    const value = invert ? 1 - values[index] : values[index];
    if (value !== previous) {
      edges.push({ time: capture.times[index], state: value });
      previous = value;
    }
  }
  return edges;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function findColumns(header, columnCount) {
  if (!header.length) {
    return { time: 0, channels: Array.from({ length: Math.max(1, columnCount - 1) }, (_, number) => ({ number, index: number + 1 })) };
  }
  const find = (pattern) => header.findIndex((cell) => pattern.test(cell));
  const time = find(/(?:time|时间)/i);
  const channels = [];
  header.forEach((cell, index) => {
    const match = cell.match(/(?:ch(?:annel)?\s*|通道\s*)(\d+)/i)
      ?? (index !== time ? cell.match(/(\d+)\s*$/) : null);
    if (match) channels.push({ number: Number(match[1]), index });
  });
  if (time >= 0 && !channels.length) {
    header.forEach((_, index) => {
      if (index !== time) channels.push({ number: channels.length, index });
    });
  }
  if (time < 0 || !channels.length) throw new Error('表头必须包含 Time 和至少一个 CH 通道列');
  return { time, channels };
}

function findTimeScale(header) {
  const lower = header.toLowerCase().replace(/μ/g, 'µ');
  if (/(?:\bns\b|纳秒)/.test(lower)) return 1e-9;
  if (/(?:µs|\bus\b|微秒)/.test(lower)) return 1e-6;
  if (/(?:\bms\b|毫秒)/.test(lower)) return 1e-3;
  return 1;
}

function parseLogic(value) {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'h', 'high', 'true'].includes(normalized)) return 1;
  if (['0', 'l', 'low', 'false'].includes(normalized)) return 0;
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? Number(number > 0) : null;
}

function detectDelimiter(line) {
  const candidates = [',', '\t', ';'];
  let best = ',';
  let count = -1;
  for (const candidate of candidates) {
    const next = line.split(candidate).length;
    if (next > count) { best = candidate; count = next; }
  }
  return count > 1 ? best : /\s{2,}/.test(line) ? /\s+/ : ',';
}

function splitLine(line, delimiter) {
  return delimiter instanceof RegExp ? line.trim().split(delimiter) : line.split(delimiter);
}

function cleanCell(value) {
  return value?.trim().replace(/^['"]|['"]$/g, '') ?? '';
}

function looksNumericRow(line) {
  const cells = splitLine(line, detectDelimiter(line)).map(cleanCell);
  return cells.length >= 4 && Number.isFinite(Number.parseFloat(cells[0]));
}

function monotonicDirection(rows) {
  let ascending = true;
  let descending = true;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].time < rows[index - 1].time) ascending = false;
    if (rows[index].time > rows[index - 1].time) descending = false;
  }
  return ascending ? 1 : descending ? -1 : 0;
}

function calculateComplementRate(capture, firstChannel, secondChannel) {
  let total = 0;
  let complementary = 0;
  for (let index = 0; index < capture.times.length - 1; index += 1) {
    const duration = capture.times[index + 1] - capture.times[index];
    if (duration <= 0) continue;
    total += duration;
    if (capture.channels[firstChannel][index] !== capture.channels[secondChannel][index]) complementary += duration;
  }
  return total ? complementary / total : 0;
}

function requireChannels(capture, channels, label) {
  const missing = channels.filter((channel) => !capture.channels[channel]);
  if (missing.length) throw new Error(`${label}缺少 ${missing.map((channel) => `CH${channel}`).join('、')}`);
}

function startLineForProbe(headerIndex, lines) {
  return Math.min(lines.length - 1, Math.max(0, headerIndex + 1));
}
