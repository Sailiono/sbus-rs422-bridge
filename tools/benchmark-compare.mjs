#!/usr/bin/env node
// Benchmark comparison tool for the SBUS→RS-422 bridge project.
//
// Computes the metrics defined in docs/comparative-benchmark-plan.md for one or
// two devices under test (DUT), and emits a Markdown report.
//
// Inputs are capture files already produced by the host tool or a logic analyzer:
//   - host-tool JSON capture  (format "sbus-422-capture", .json)
//   - synchronized logic CSV   (Time, CH0, CH1, CH2)  -> single DUT, full timing
//   - isolated dual CSV       (input file CH0, output file CH1/CH2)
//
// Usage:
//   node tools/benchmark-compare.mjs --dut-a <file> [--dut-a-name "..."] \
//                                    --dut-b <file> [--dut-b-name "..."] \
//                                    [--a-mode json|sync] [--b-mode ...] \
//                                    [--meta "key=value,..."] > report.md
//
// For isolated-capture mode, pass the input and output CSVs as one comma-
// separated slot, e.g. --dut-a "input.csv,output.csv".
//
// If only one DUT is supplied, the tool reports that DUT's metrics alone.
// When both are supplied it adds a side-by-side comparison and a delta summary.

import { readFileSync } from 'node:fs';
import {
  calculateStats,
  captureFromJson,
  compareFrameSequences,
} from '../src/sbus.js';
import {
  analyzeDualModules,
  analyzeIsolatedCaptures,
  analyzeLogicCapture,
  autoDetectMapping,
  parseLogicCaptureText,
} from '../src/logic-capture.js';

const VALID_END_BYTES = new Set([0x00, 0x04, 0x14, 0x24, 0x34]);

function fail(message) {
  process.stderr.write(`benchmark-compare: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { aMeta: {}, bMeta: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[index + 1];
    switch (token) {
      case '--dut-a': args.dutA = next(); index += 1; break;
      case '--dut-b': args.dutB = next(); index += 1; break;
      case '--dut-a-name': args.dutAName = next(); index += 1; break;
      case '--dut-b-name': args.dutBName = next(); index += 1; break;
      case '--a-mode': args.aMode = next(); index += 1; break;
      case '--b-mode': args.bMode = next(); index += 1; break;
      case '--meta':
        for (const pair of next().split(',')) {
          const [key, value] = pair.split('=');
          if (key) args.aMeta[key.trim()] = (value ?? '').trim();
        }
        index += 1;
        break;
      case '--b-meta':
        for (const pair of next().split(',')) {
          const [key, value] = pair.split('=');
          if (key) args.bMeta[key.trim()] = (value ?? '').trim();
        }
        index += 1;
        break;
      case '--dual': args.dual = next(); index += 1; break;
      case '--a-baud': args.aBaud = Number(next()); index += 1; break;
      case '--b-baud': args.bBaud = Number(next()); index += 1; break;
      case '--a-parity': args.aParity = next(); index += 1; break;
      case '--b-parity': args.bParity = next(); index += 1; break;
      case '--a-stop': args.aStop = Number(next()); index += 1; break;
      case '--b-stop': args.bStop = Number(next()); index += 1; break;
      case '--a-name': args.dutAName = next(); index += 1; break;
      case '--b-name': args.dutBName = next(); index += 1; break;
      default: fail(`unknown argument: ${token}`);
    }
  }
  if (!args.dutA && !args.dutB && !args.dual) fail('provide at least one of --dut-a / --dut-b, or --dual');
  return args;
}

function loadCapture(path, mode) {
  const text = readFileSync(path, 'utf8');
  if (mode === 'json' || (mode === undefined && path.toLowerCase().endsWith('.json'))) {
    return { kind: 'json', frames: captureFromJson(text), path };
  }
  if (mode === undefined) mode = 'sync';
  const capture = parseLogicCaptureText(text, path);
  if (mode === 'sync') {
    return { kind: 'sync', analysis: analyzeLogicCapture(capture), path };
  }
  if (mode === 'isolated') {
    // For isolated mode two files are needed; handled by loadIsolatedPair.
    return { kind: 'isolated-single', capture, path };
  }
  fail(`unknown mode "${mode}" for ${path}`);
}

function loadIsolatedPair(inputPath, outputPath, name) {
  const input = parseLogicCaptureText(readFileSync(inputPath, 'utf8'), inputPath);
  const output = parseLogicCaptureText(readFileSync(outputPath, 'utf8'), outputPath);
  const analysis = analyzeIsolatedCaptures(input, output);
  analysis.inputPath = inputPath;
  analysis.outputPath = outputPath;
  return { kind: 'isolated', analysis, name, path: `${inputPath} + ${outputPath}` };
}

// Auto-detect an isolated pair. A DUT slot may be either a single file
// (json capture, or a synchronized CSV) or a comma-separated
// "input.csv,output.csv" pair for isolated-capture mode.
function resolveDut(file, mode, name) {
  if (file.includes(',')) {
    const [inputPath, outputPath] = file.split(',').map((part) => part.trim());
    return loadIsolatedPair(inputPath, outputPath, name);
  }
  return loadCapture(file, mode);
}

function resolveDual(path, params) {
  const capture = parseLogicCaptureText(readFileSync(path, 'utf8'), path);
  const mapping = autoDetectMapping(capture);
  const options = {
    a: { baud: params.aBaud, parity: params.aParity, stopBits: params.aStop },
    b: { baud: params.bBaud, parity: params.bParity, stopBits: params.bStop },
  };
  const result = analyzeDualModules(capture, mapping, options);
  result.path = path;
  return { kind: 'dual', analysis: result, mapping, path };
}

function headerChannels(text) {
  const first = text.split('\n').find((line) => /time|时间/i.test(line));
  const set = new Set();
  if (!first) return set;
  first.split(/[,;\t\s]+/).forEach((cell) => {
    const match = cell.match(/(?:ch(?:annel)?|通道)\s*(\d+)/i) ?? cell.match(/(\d+)\s*$/);
    if (match) set.add(Number(match[1]));
  });
  return set;
}

function pct(value) { return `${(value * 100).toFixed(4)}%`; }
function ratePerSec(baud) { return baud ? `${baud.toFixed(2)} bit/s` : '—'; }
function us(seconds) { return seconds != null ? `${(seconds * 1e6).toFixed(3)} µs` : '—'; }

function metricsFor(result) {
  if (result.kind === 'dual') {
    const analysis = result.analysis;
    const render = (side, label) => {
      const m = side;
      const comparison = analysis.frameComparison ?? { matched: 0, comparable: 0, matchRate: 0 };
      const stats = m.stats ?? { frameRate: 0, meanInterval: null, jitter: null, lostFrames: 0, failsafeFrames: 0 };
      const errors = comparison.comparable - comparison.matched;
      return {
        name: label,
        source: 'multi-channel LA2016 capture (dual-module decode)',
        frames: m.frames.length,
        frameErrors: errors,
        frameErrorRate: comparison.comparable ? errors / comparison.comparable : 0,
        byteErrorRate: comparison.comparable ? errors / comparison.comparable / 25 : 0,
        frameRate: stats.frameRate,
        meanIntervalMs: stats.meanInterval,
        jitterMs: stats.jitter,
        lostFrames: stats.lostFrames,
        failsafeFrames: stats.failsafeFrames,
        dataintegrity: comparison.matchRate,
        timing: { note: 'Single synchronized acquisition: both modules captured on the same time base, so per-module baud and output frames are comparable in isolation.' },
        baudInput: null,
        baudOutput: m.baudRate,
        baudDiff: null,
        complementRate: m.complementRate,
        delay: null,
        raw: { mapping: m.mapping, dut: m },
      };
    };
    return {
      kind: 'dual-pair',
      a: render(analysis.dutA, 'DUT-A (自研纯硬件桥)'),
      b: render(analysis.dutB, 'DUT-B (商用 MCU 模块)'),
      comparison: analysis.frameComparison,
      mapping: result.mapping,
    };
  }
  if (result.kind === 'json') {
    const frames = result.frames;
    const stats = calculateStats(frames);
    const errors = frames.filter((frame) => !frame.headerValid || !frame.footerValid).length;
    return {
      source: 'host-tool JSON capture',
      frames: frames.length,
      frameErrors: errors,
      frameErrorRate: frames.length ? errors / frames.length : 0,
      byteErrorRate: frames.length ? errors / (frames.length * 25) : 0,
      frameRate: stats.frameRate,
      meanIntervalMs: stats.meanInterval,
      jitterMs: stats.jitter,
      lostFrames: stats.lostFrames,
      failsafeFrames: stats.failsafeFrames,
      dataintegrity: frames.length ? (frames.length - errors) / frames.length : 0,
      timing: { note: 'JSON capture has no input-side reference, so byte-for-byte transparency and propagation delay are not computable from this file alone.' },
      baudInput: null,
      baudOutput: null,
      delay: null,
    };
  }

  const analysis = result.analysis;
  const input = analysis.inputFrames ?? [];
  const output = analysis.outputFrames ?? [];
  const comparison = analysis.frameComparison ?? { matched: 0, comparable: 0, matchRate: 0 };
  const stats = analysis.inputStats ?? calculateStats(input);
  const delays = analysis.delays;
  const timingNote = analysis.synchronized
    ? 'Synchronized single-file capture: propagation delay computed from the shared time base.'
    : 'Isolated dual-file capture: data content and baud rate are comparable, but propagation delay is not measurable (separate acquisitions).';

  return {
    source: analysis.synchronized ? 'synchronized logic CSV' : 'isolated dual-file logic CSV',
    frames: output.length,
    frameErrors: comparison.comparable - comparison.matched,
    frameErrorRate: comparison.comparable ? (comparison.comparable - comparison.matched) / comparison.comparable : 0,
    byteErrorRate: comparison.comparable ? (comparison.comparable - comparison.matched) / comparison.comparable / 25 : 0,
    frameRate: stats.frameRate,
    meanIntervalMs: stats.meanInterval,
    jitterMs: stats.jitter,
    lostFrames: stats.lostFrames,
    failsafeFrames: stats.failsafeFrames,
    dataintegrity: comparison.matchRate,
    timing: { note: timingNote },
    baudInput: analysis.inputBaudRate,
    baudOutput: analysis.outputBaudRate,
    baudDiff: analysis.baudDifferenceRate,
    complementRate: analysis.complementRate,
    delay: delays && delays.samples ? {
      samples: delays.samples,
      median: delays.median,
      p95: delays.p95Absolute,
      min: delays.min,
      max: delays.max,
    } : null,
  };
}

function renderMetrics(m, name) {
  const lines = [];
  lines.push(`### ${name}`);
  lines.push('');
  lines.push(`- **Source**: ${m.source}`);
  lines.push(`- **Valid output frames**: ${m.frames}`);
  lines.push(`- **Frame error rate**: ${pct(m.frameErrorRate)} (${m.frameErrors} / ${m.frames})`);
  lines.push(`- **Byte error rate**: ${pct(m.byteErrorRate)}`);
  lines.push(`- **Data transparency (byte-for-byte match)**: ${pct(m.dataintegrity)}`);
  lines.push(`- **Frame rate**: ${m.frameRate ? `${m.frameRate.toFixed(3)} Hz` : '—'}`);
  lines.push(`- **Mean frame interval**: ${m.meanIntervalMs ? `${m.meanIntervalMs.toFixed(3)} ms` : '—'}`);
  lines.push(`- **Arrival jitter σ**: ${m.jitterMs ? `${m.jitterMs.toFixed(3)} ms` : '—'}`);
  lines.push(`- **FRAME LOST / FAILSAFE**: ${m.lostFrames} / ${m.failsafeFrames}`);
  if (m.baudInput != null) {
    lines.push(`- **Input / output baud**: ${ratePerSec(m.baudInput)} / ${ratePerSec(m.baudOutput)} (Δ ${pct(m.baudDiff ?? 0)})`);
    lines.push(`- **RS-422 complement rate**: ${pct(m.complementRate)}`);
  }
  if (m.delay) {
    lines.push(`- **Propagation delay** (${m.delay.samples} edges): median ${us(m.delay.median)}, P95 ${us(m.delay.p95)}, min ${us(m.delay.min)}, max ${us(m.delay.max)}`);
  }
  lines.push(`- **Timing note**: ${m.timing.note}`);
  lines.push('');
  return lines.join('\n');
}

function renderComparison(a, b) {
  const rows = [
    ['Metric', a.name, b.name, 'Better'],
    ['Valid frames', a.m.frames, b.m.frames, '—'],
    ['Frame error rate', pct(a.m.frameErrorRate), pct(b.m.frameErrorRate), lower(a.m.frameErrorRate, b.m.frameErrorRate)],
    ['Byte error rate', pct(a.m.byteErrorRate), pct(b.m.byteErrorRate), lower(a.m.byteErrorRate, b.m.byteErrorRate)],
    ['Data transparency', pct(a.m.dataintegrity), pct(b.m.dataintegrity), higher(a.m.dataintegrity, b.m.dataintegrity)],
    ['Frame rate (Hz)', a.m.frameRate.toFixed(3), b.m.frameRate.toFixed(3), '—'],
    ['Jitter σ (ms)', a.m.jitterMs.toFixed(3), b.m.jitterMs.toFixed(3), lowerNum(a.m.jitterMs, b.m.jitterMs)],
    ['FRAME LOST', a.m.lostFrames, b.m.lostFrames, lower(a.m.lostFrames, b.m.lostFrames)],
    ['FAILSAFE', a.m.failsafeFrames, b.m.failsafeFrames, lower(a.m.failsafeFrames, b.m.failsafeFrames)],
  ];
  if (a.m.baudInput != null && b.m.baudInput != null) {
    rows.push(['Baud Δ', pct(a.m.baudDiff ?? 0), pct(b.m.baudDiff ?? 0), lower(a.m.baudDiff ?? 1, b.m.baudDiff ?? 1)]);
    rows.push(['Complement rate', pct(a.m.complementRate), pct(b.m.complementRate), higher(a.m.complementRate, b.m.complementRate)]);
  }
  if (a.m.delay && b.m.delay) {
    rows.push(['Delay median (µs)', us(a.m.delay.median), us(b.m.delay.median), lowerNum(a.m.delay.median, b.m.delay.median)]);
    rows.push(['Delay P95 (µs)', us(a.m.delay.p95), us(b.m.delay.p95), lowerNum(a.m.delay.p95, b.m.delay.p95)]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
  const fmt = (row) => `| ${row.map((cell, col) => String(cell).padEnd(widths[col])).join(' | ')} |`;
  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [fmt(rows[0]), sep, ...rows.slice(1).map(fmt)].join('\n');
}

function tag(better, x, y) {
  if (x == null || y == null) return '—';
  if (x === y) return 'tie';
  return better ? 'A' : 'B';
}
function lower(x, y) { return tag(x < y, x, y); }
function higher(x, y) { return tag(x > y, x, y); }
function lowerNum(x, y) { return tag(x < y, x, y); }

function main() {
  const args = parseArgs(process.argv.slice(2));

  const params = {
    aBaud: args.aBaud, bBaud: args.bBaud,
    aParity: args.aParity ?? 'even', bParity: args.bParity ?? 'even',
    aStop: args.aStop ?? 2, bStop: args.bStop ?? 2,
  };

  let a = null;
  let b = null;
  let dualMap = null;

  if (args.dual) {
    const dual = metricsFor(resolveDual(args.dual, params));
    a = { name: args.dutAName ?? dual.a.name, m: dual.a };
    b = { name: args.dutBName ?? dual.b.name, m: dual.b };
    dualMap = dual;
  } else {
    if (args.dutA) a = { name: args.dutAName ?? 'DUT-A (pure-hardware bridge)', m: metricsFor(resolveDut(args.dutA, args.aMode, args.dutAName)) };
    if (args.dutB) b = { name: args.dutBName ?? 'DUT-B (MCU module)', m: metricsFor(resolveDut(args.dutB, args.bMode, args.dutBName)) };
  }

  const out = [];
  out.push('# SBUS→RS-422 Benchmark Report');
  out.push('');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push('> Metrics follow `docs/comparative-benchmark-plan.md`. This is a data summary, not a conclusion; adverse data must be archived as-is.');
  out.push('');
  if (dualMap) {
    const mp = dualMap.mapping;
    out.push('## Channel mapping (auto-detected)');
    out.push('');
    out.push(`- **Reference (SBUS)**: channel ${mp.input}`);
    out.push(`- **DUT-A**: output +${mp.a.pos} / -${mp.a.neg}`);
    out.push(`- **DUT-B**: output +${mp.b.pos} / -${mp.b.neg}`);
    out.push('');
    if (dualMap.comparison) {
      out.push('## Dual-module frame comparison');
      out.push('');
      out.push(`- **Comparable frames**: ${dualMap.comparison.comparable}`);
      out.push(`- **Matched frames**: ${dualMap.comparison.matched}`);
      out.push(`- **Match rate**: ${pct(dualMap.comparison.matchRate)}`);
      out.push(`- **Delay (A↔B)**: median ${us(dualMap.comparison.delay?.median)}, p95 ${us(dualMap.comparison.delay?.p95)}, min ${us(dualMap.comparison.delay?.min)}, max ${us(dualMap.comparison.delay?.max)}`);
      out.push('');
    }
  }
  if (a) out.push(renderMetrics(a.m, a.name));
  if (b) out.push(renderMetrics(b.m, b.name));
  if (a && b) {
    out.push('## Side-by-side');
    out.push('');
    out.push(renderComparison(a, b));
    out.push('');
    out.push('> "Better" marks the lower error/jitter/delay or higher transparency/complement rate. It is a raw indicator, not a verdict on overall suitability.');
  }
  if (!a || !b) {
    out.push('## Note');
    out.push('');
    if (args.dual) {
      out.push('A single multi-channel capture was decoded for both modules. Use explicit `--dut-a`/`--dut-b` (or another `--dual` file) to compare two separate acquisitions.');
    } else {
      out.push('Only one DUT was analyzed. To compare against the commercial MCU module, run with both `--dut-a` and `--dut-b`, or use `--dual <la2016.csv>` for a single multi-channel capture.');
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}

main();
