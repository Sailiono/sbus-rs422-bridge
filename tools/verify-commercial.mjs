#!/usr/bin/env node
// 验证商用「原始 SBUS 协议」模块（帧缓冲式转换）的实测行为。
// 用法: node tools/verify-commercial.mjs <logic_capture.csv> [--baud=115200]
//   CSV 需含: SBUS 参考(反相存储)、422+、422- 三路。
//   兼容两种接线极性: 自动探测差分方向取 (422+ - 422-) 或 (422- - 422+)。
//
// ⚠ 采样率要求: UART 解码需每 bit 至少 ~8 采样点。SBUS=100k 需 ≥800kS/s,
//   商用115200 需 ≥920kS/s。采样率不足(如 ~117kS/s)时每 bit 仅 1 点, 解出的
//   "帧"虽可能以 0x0F 开头, 但内容/帧尾不可信 —— 此时脚本会警告并拒绝下结论。
//
// 判据(采样率足够时):
//   - 商用输出帧头严格 0x0F, 帧尾(第25字节)为 0x00(合法SBUS)。
//   - 每个 SBUS 输入帧之后紧跟一个商用回复帧(收到才发)。
//   - 商用回复帧 payload 应随输入 SBUS 帧内容变化(内容一致性高=透传)。
//   - 帧级延迟 = 商用帧起始 - 对应 SBUS 帧起始, 应 >0 且体现帧缓冲(~一帧周期)。

import { parseLogicCaptureText } from '../src/logic-capture.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const path = args.find(a => !a.startsWith('--'));
const baud = Number((args.find(a => a.startsWith('--baud=')) || '--baud=115200').split('=')[1]) || 115200;
if (!path) { console.error('用法: node tools/verify-commercial.mjs <logic_capture.csv> [--baud=115200]'); process.exit(1); }

const cap = parseLogicCaptureText(readFileSync(path, 'utf8'), path);
const cols = Object.keys(cap.channels).map(Number);
if (cols.length < 3) { console.error('需至少 3 路通道 (SBUS, 422+, 422-)'); process.exit(1); }
const [SBUS, P, N] = cols;

// 采样率检查: 排除逻辑分析仪同一时刻多通道记录的亚微秒成对间隔
let dtMin = Infinity;
for (let i = 1; i < cap.times.length; i++) { const d = cap.times[i] - cap.times[i - 1]; if (d > 1e-6 && d < dtMin) dtMin = d; }
const minBaud = dtMin !== Infinity ? 1 / dtMin : 0;
console.log(`采样率上限: 最快间隔 ${(dtMin * 1e6).toFixed(2)} µs ≈ ${(minBaud / 1000).toFixed(0)} kS/s`);
const needRate = Math.max(100000, baud) * 8;
console.log(`可靠解码需 ≥ ${(needRate / 1000).toFixed(0)} kS/s (每bit 8点)`);
if (minBaud < needRate) {
  console.log('⚠ 采样率不足: 解出的帧内容/帧尾不可信, 仅边沿间隔(波特率)判断有效。请提高采样率后重采。\n');
}

// 自动探测差分方向: 试两种, 选解出更多 0x0F 帧者
function makeDiff(mode) {
  const a = cap.channels[P], b = cap.channels[N];
  const out = new Uint8Array(a.length);
  for (let i = 0; i < out.length; i++) {
    if (mode === 'pn') out[i] = a[i] > b[i] ? 1 : 0;
    else out[i] = b[i] > a[i] ? 1 : 0;
  }
  return out;
}
function byteStream(ch, invert, bp) {
  const times = cap.times;
  function gs(t) { let lo = 0, hi = ch.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; } return ch[lo]; }
  const starts = []; for (let i = 1; i < ch.length; i++) if (ch[i - 1] === 1 && ch[i] === 0) starts.push(i);
  const bytes = []; let lt = -1;
  for (const s of starts) { const t = times[s]; if (t - lt < bp * 0.5) continue; const d = []; for (let b = 0; b < 8; b++) { let st = gs(t + (1.5 + b) * bp); if (invert) st = 1 - st; d.push(st); } bytes.push({ byte: d.reduce((v, bit, idx) => v | (bit << idx), 0), t0: t }); lt = t; }
  return bytes;
}
function frames(list) { const fr = []; for (let i = 0; i + 25 <= list.length; i++) if (list[i].byte === 0x0F) fr.push({ t: list[i].t0, b: list.slice(i, i + 25).map(x => x.byte) }); return fr; }

const rf = frames(byteStream(cap.channels[SBUS], true, 1 / 100000));
let diffMode = null, cf = [];
for (const mode of ['pn', 'np']) {
  const cand = frames(byteStream(makeDiff(mode), false, 1 / baud));
  if (cand.length > cf.length) { cf = cand; diffMode = mode; }
}
console.log(`差分方向: 422${diffMode === 'pn' ? '+' : '-'} - 422${diffMode === 'pn' ? '-' : '+'}   商用波特率: ${baud}`);
console.log(`SBUS 输入帧: ${rf.length}   商用输出帧(严格0x0F): ${cf.length}`);

// 边沿波特率检测 (不受采样率不足影响, 只要能数到边沿)
function edgeBaud(ch) {
  const edges = [];
  for (let i = 1; i < ch.length; i++) if (ch[i] !== ch[i - 1]) edges.push(cap.times[i]);
  const gaps = edges.slice(1).map((t, i) => t - edges[i]).filter(g => g >= 1e-6);
  if (!gaps.length) return 0;
  const hist = new Map();
  for (const g of gaps) { const k = Math.round(g * 1e7) / 10; hist.set(k, (hist.get(k) || 0) + 1); }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  return top.map(([k, v]) => `${(1 / (k * 1e-6) / 1000).toFixed(1)}k(${v})`).join(' ');
}
function edgeBaudNum(ch) {
  const edges = [];
  for (let i = 1; i < ch.length; i++) if (ch[i] !== ch[i - 1]) edges.push(cap.times[i]);
  const gaps = edges.slice(1).map((t, i) => t - edges[i]).filter(g => g >= 1e-6);
  if (!gaps.length) return 0;
  const hist = new Map();
  for (const g of gaps) { const k = Math.round(g * 1e7) / 10; hist.set(k, (hist.get(k) || 0) + 1); }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? 1 / (top[0] * 1e-6) : 0;
}
console.log(`边沿波特率(峰值): SBUS≈${edgeBaud(cap.channels[SBUS])}  商用422≈${edgeBaud(makeDiff(diffMode))}`);

if (cf.length) {
  const tailOk = cf.every(f => f.b[24] === 0x00);
  console.log(`商用帧尾(第25字节)全为0x00: ${tailOk ? '是(合法SBUS)' : '否(非合法SBUS/采样不足)'}`);
  console.log(`商用首帧: ${cf[0].b.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
  console.log(`SBUS首帧: ${rf[0]?.b.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ') ?? '(无)'}`);
}
if (minBaud < needRate || !rf.length || !cf.length) { console.log('帧数不足或采样率不足, 不做帧级对比。'); process.exit(0); }

let matched = 0, contentSame = 0; const delays = [];
for (const r of rf) {
  let best = null, bd = Infinity;
  for (const c of cf) { const d = c.t - r.t; if (d >= -0.001 && d < bd) { bd = d; best = c; } }
  if (best) { matched++; delays.push(bd); const same = best.b.every((v, j) => v === r.b[j]); if (same) contentSame++; }
}
delays.sort((a, b) => a - b);
const pct = p => delays[Math.floor(p / 100 * (delays.length - 1))];
console.log(`\n=== 帧级时序匹配 ===`);
console.log(`匹配率: ${matched}/${rf.length}`);
if (delays.length) console.log(`帧级延迟: 中位${(pct(50) * 1e3).toFixed(2)}ms P95${(pct(95) * 1e3).toFixed(2)}ms P99${(pct(99) * 1e3).toFixed(2)}ms min${(delays[0] * 1e3).toFixed(2)}ms max${(delays[delays.length - 1] * 1e3).toFixed(2)}ms`);
console.log(`内容一致性(匹配帧中 payload 相同): ${contentSame}/${matched} (${(100 * contentSame / matched || 0).toFixed(1)}%)`);

if (contentSame / matched < 0.99) {
  console.log('\n⚠ 商用回复帧内容与输入不一致 => 要么模块未透传, 要么采样率不足致解码错。');
  console.log('   先确认采样率 ≥ ' + (needRate / 1000).toFixed(0) + ' kS/s 且模块处于 SBUS 透传模式。');
}
