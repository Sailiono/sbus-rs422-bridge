#!/usr/bin/env node
// 验证商用「原始 SBUS 协议」模块（帧缓冲式转换）的实测行为。
// 用法: node tools/verify-commercial.mjs <logic_capture.csv>
//   CSV 需含三路: SBUS 参考(反相存储)、422+、422-。
//   实测极性: SBUS 与 422- 同相、422+ 反相 => 差分还原取 422- - 422+。
//
// 判据:
//   - 商用输出按 115200/8N1 解码, 帧头应为严格 0x0F, 帧尾(第25字节)应为 0x00。
//   - 每个 SBUS 输入帧之后应紧跟一个商用回复帧 (收到才发)。
//   - 商用回复帧 payload 应随输入 SBUS 帧内容变化 (内容一致性应高, 证明透传)。
//   - 帧级延迟 = 商用帧起始 - 对应 SBUS 帧起始, 应 >0 且体现帧缓冲(~一帧周期)。

import { parseLogicCaptureText } from '../src/logic-capture.js';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('用法: node tools/verify-commercial.mjs <logic_capture.csv>'); process.exit(1); }

const cap = parseLogicCaptureText(readFileSync(path, 'utf8'), path);
const cols = Object.keys(cap.channels).map(Number);
if (cols.length < 3) { console.error('需至少 3 路通道 (SBUS, 422+, 422-)'); process.exit(1); }
const [SBUS, P, N] = cols;

// 差分还原: 422- - 422+
const diff = new Uint8Array(cap.channels[P].length);
for (let i = 0; i < diff.length; i++) diff[i] = cap.channels[N][i] - cap.channels[P][i] > 0 ? 1 : 0;

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
const cf = frames(byteStream(diff, false, 1 / 115200));

console.log(`SBUS 输入帧: ${rf.length}   商用输出帧(严格0x0F): ${cf.length}`);
if (cf.length) {
  const tailOk = cf.every(f => f.b[24] === 0x00);
  console.log(`商用帧尾(第25字节)全为0x00: ${tailOk ? '是(合法SBUS)' : '否(非合法SBUS帧!)'}`);
  console.log(`商用首帧: ${cf[0].b.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
  console.log(`SBUS首帧: ${rf[0]?.b.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ') ?? '(无)'}`);
}
if (!rf.length || !cf.length) { console.log('帧数不足, 无法对比。'); process.exit(0); }

// 每个 SBUS 帧匹配其后最近的商用帧
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
  console.log('\n⚠ 商用回复帧内容不随输入变化 => 模块未处于 SBUS 透传模式, 无法做帧级内容对比。');
  console.log('   请确认: 模块模式=原始SBUS透传; 422接线正确; 输入SBUS源在发送变化数据。');
}
