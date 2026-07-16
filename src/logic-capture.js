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
  const probe = splitLine(lines[Math.max(0, startLineForProbe(headerIndex, lines))], delimiter);
  const columns = findColumns(header, probe.length);
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

  const columnLabels = columns.channels
    .sort((a, b) => a.number - b.number)
    .map(({ number, index }) => header[index] ?? `CH${number}`);

  return {
    format: 'logic-capture-text-v1',
    fileName,
    sourceRows: rows.length,
    times: Float64Array.from(times),
    channelNumbers: columns.channels.map(({ number }) => number),
    columnLabels,
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

export function decodeUart8E2(capture, channel, {
  invert = false,
  bitPeriod = DEFAULT_BIT_PERIOD,
  parity = 'even',
  stopBits = 2,
} = {}) {
  const edges = getEdges(capture, channel, invert);
  const validBytes = [];
  const invalidFrames = [];
  const stopCount = Math.max(1, stopBits | 0);
  let busyUntil = -Infinity;
  for (const edge of edges) {
    if (edge.state !== 0 || edge.time < busyUntil) continue;
    const data = [];
    for (let bit = 0; bit < 8; bit += 1) {
      data.push(getStateAt(capture, edge.time + (1.5 + bit) * bitPeriod, channel, invert));
    }
    const parityBit = parity === 'none' ? 0 : getStateAt(capture, edge.time + 9.5 * bitPeriod, channel, invert);
    const parityValid = parity === 'none'
      ? true
      : parity === 'odd'
        ? (data.reduce((sum, value) => sum + value, 0) + parityBit) % 2 === 1
        : (data.reduce((sum, value) => sum + value, 0) + parityBit) % 2 === 0;
    const stopChecks = [];
    for (let stop = 0; stop < stopCount; stop += 1) {
      stopChecks.push(getStateAt(capture, edge.time + (10.5 + stop) * bitPeriod, channel, invert));
    }
    const stopValid = stopChecks.every((value) => value === 1);
    const byte = data.reduce((value, bit, index) => value | (bit << index), 0);
    const item = { byte, startTime: edge.time, parityValid, stopValid };
    if (parityValid && stopValid) validBytes.push(item);
    else invalidFrames.push(item);
    const totalBits = 1 + 8 + (parity === 'none' ? 0 : 1) + stopCount;
    busyUntil = edge.time + (totalBits - 0.2) * bitPeriod;
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
    if (index === time) return;
    const match = cell.match(/(?:ch(?:annel)?\s*|通道\s*)(\d+)/i);
    if (match) {
      channels.push({ number: Number(match[1]), index });
      return;
    }
    // Generic headers (e.g. Chinese labels like "SBUS", "淘宝422+", or bare
    // column numbers). Assign a positional channel number so any logic-analyzer
    // export can be mapped by the caller.
    channels.push({ number: channels.length, index });
  });
  if (time < 0 || !channels.length) throw new Error('表头必须包含 Time 和至少一个数据通道列');
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

// Map a single multi-channel capture into one or more role-fixed sub-captures.
// `mapping` uses the original column indices from `parseLogicCaptureText`.
// A DUT is described by { pos, neg } column indices; the input by { input }.
function applyRoleMapping(capture, { input, a, b } = {}) {
  const build = (pos, neg) => {
    const channels = {
      0: capture.channels[input ?? pos],
      1: capture.channels[pos],
      2: capture.channels[neg],
    };
    return { ...capture, channels };
  };
  return {
    input: input != null ? { ...capture, channels: { 0: capture.channels[input] } } : null,
    a: a ? build(a.pos, a.neg) : null,
    b: b ? build(b.pos, b.neg) : null,
  };
}

// Heuristic mapping for the common LA2016 export where one file holds the shared
// SBUS input plus two modules' RS-422 ± outputs (e.g. "SBUS", "淘宝422+",
// "淘宝422-", "自研422+", "自研422-").
export function autoDetectMapping(capture) {
  const labels = capture.columnLabels ?? capture.channelNumbers.map((n) => `CH${n}`);
  const roles = labels.map((label) => {
    const text = String(label).toLowerCase();
    const isPos = /422\+|422 \+|\+$|[+＋]$|\+/.test(label) && /422/.test(label);
    const isNeg = /422[-－]|[-－]$/.test(label) && /422/.test(label);
    const isSbus = /sbus|s.bus|sbys/.test(text) && !isPos && !isNeg;
    return { label, isSbus, isPos, isNeg };
  });
  const sbus = roles.findIndex((role) => role.isSbus);
  const positives = roles.map((role, index) => (role.isPos ? index : -1)).filter((index) => index >= 0);
  const negatives = roles.map((role, index) => (role.isNeg ? index : -1)).filter((index) => index >= 0);
  const mapping = {};
  if (sbus >= 0) mapping.input = capture.channelNumbers[sbus];
  // Pair positives/negatives by position. First pair = DUT-A, second = DUT-B.
  const pairs = Math.min(positives.length, negatives.length);
  if (pairs >= 1) mapping.a = { pos: capture.channelNumbers[positives[0]], neg: capture.channelNumbers[negatives[0]] };
  if (pairs >= 2) mapping.b = { pos: capture.channelNumbers[positives[1]], neg: capture.channelNumbers[negatives[1]] };
  return mapping;
}

export function analyzeDualModules(capture, mapping, options = {}) {
  const mapped = applyRoleMapping(capture, mapping);
  if (!mapped.input) throw new Error('双模块对比需要指定 SBUS 输入通道');
  if (!mapped.a && !mapped.b) throw new Error('双模块对比需要至少一个 RS-422 输出对（CH1/CH2）');

  const bitPeriodFor = (side, opts, hint) => {
    const estimated = estimateBitPeriod(side, 1, hint);
    if (opts?.baud) {
      const fromBaud = 1 / opts.baud;
      // Trust an explicit user baud unless the auto-estimate is close
      // (within 10%) and the explicit value looks off.
      if (!estimated || Math.abs(estimated - fromBaud) / fromBaud > 0.1) return fromBaud;
      return estimated;
    }
    return estimated || hint;
  };

  const analyzeSide = (side, label, opts) => {
    if (!side) return null;
    const inputBitPeriod = estimateBitPeriod(mapped.input, 0, DEFAULT_BIT_PERIOD);
    const inputUart = decodeUart8E2(mapped.input, 0, { invert: true, bitPeriod: inputBitPeriod });
    const inputFrames = decodeSbusFrames(inputUart.validBytes);
    const outBitPeriod = bitPeriodFor(side, opts, DEFAULT_BIT_PERIOD);
    const outUart = decodeUart8E2(side, 1, {
      invert: false,
      bitPeriod: outBitPeriod,
      parity: opts?.parity ?? 'even',
      stopBits: opts?.stopBits ?? 2,
    });
    const outFrames = decodeSbusFrames(outUart.validBytes);
    const delays = calculatePropagationDelays(side, 1, true, Math.min(inputBitPeriod, outBitPeriod));
    return {
      label,
      baudRate: outBitPeriod ? 1 / outBitPeriod : 0,
      bitPeriod: outBitPeriod,
      parity: opts?.parity ?? 'even',
      stopBits: opts?.stopBits ?? 2,
      complementRate: calculateComplementRate(side, 1, 2),
      uart: outUart,
      frames: outFrames,
      stats: calculateStats(outFrames),
      delays,
      inputFrames,
    };
  };

  const dutA = analyzeSide(mapped.a, 'DUT-A (自研纯硬件桥)', options.a);
  const dutB = analyzeSide(mapped.b, 'DUT-B (商用 MCU 模块)', options.b);
  const frameComparison = dutA && dutB ? compareFrameSequences(dutA.frames, dutB.frames) : null;

  return {
    format: 'dual-module-analysis-v1',
    synchronized: true,
    sharedInput: Boolean(mapped.input),
    dutA,
    dutB,
    frameComparison,
    note: '两个模块共享同一 SBUS 输入；各自按所设信号参数（波特率 / 校验 / 停止位）独立解码与估算传播延迟，再按 SBUS 帧内容对齐对比输出一致性。',
  };
}

