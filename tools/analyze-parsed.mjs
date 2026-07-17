#!/usr/bin/env node
// 分析逻辑分析仪自带 UART 解析器导出的字节流 CSV（已解码为字节，非原始采样）。
// 用法:
//   node tools/analyze-parsed.mjs <sbus_csv> <commercial_csv> [--label=淘宝]
//   node tools/analyze-parsed.mjs <sbus_csv> <diy_csv> <commercial_csv> [--label=淘宝]
//   文件格式: Time [s],Value,Parity Error,Framing Error
//   - sbus_csv      : SBUS 参考输入 (100k/8E2, 每帧25字节, 帧头0x0F)
//   - diy_csv       : 自研纯硬件桥输出 (与SBUS同波特率, 应逐字节一致)
//   - commercial_csv: 商用模块输出 (如115200/8N1, 重封装同一SBUS帧)
//
// 输出: 帧数、内容一致性、帧级延迟(中位/抖动)、零延迟验证。
// 与 verify-commercial.mjs 区别: 本工具吃分析仪已解码字节流, 不受采样率限制。

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const label = (args.find(a => a.startsWith('--label=')) || '--label=商用').split('=')[1];
if (files.length < 2) { console.error('用法: node tools/analyze-parsed.mjs <sbus_csv> <diy_csv|commercial_csv> [<commercial_csv>] [--label=淘宝]'); process.exit(1); }

function loadCsv(path) {
  const text = readFileSync(path, 'utf8').replace(/\r/g, '');
  const lines = text.split('\n').filter(l => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 2) continue;
    rows.push({ t: parseFloat(c[0]), v: parseInt(c[1].trim(), 16), err: !!(c[2] && c[2].trim()) || !!(c[3] && c[3].trim()) });
  }
  return rows;
}
function frames(rows) {
  const idx = [];
  for (let i = 0; i + 25 <= rows.length; i++) {
    if (rows[i].v === 0x0F && i % 25 === 0 && rows[i + 24]) idx.push(i);
  }
  return idx.map(i => ({ t: rows[i].t, bytes: rows.slice(i, i + 25).map(r => r.v), errs: rows.slice(i, i + 25).map(r => r.err) }));
}

const [sbPath, bPath, cPath] = files;
const sbFr = frames(loadCsv(sbPath));
const bFr = frames(loadCsv(bPath));
const cFr = cPath ? frames(loadCsv(cPath)) : null;

function compare(name, ref, other, isDiy) {
  console.log(`\n=== ${name} vs SBUS ===`);
  console.log(`帧数: SBUS ${ref.length} / ${name} ${other.length}`);
  if (!ref.length || !other.length) { console.log('帧数不足'); return; }
  const n = Math.min(ref.length, other.length);
  let byteEq = 0, frameEq = 0;
  const delays = [];
  for (let i = 0; i < n; i++) {
    const r = ref[i], o = other[i];
    if (r.bytes.every((v, j) => v === o.bytes[j]) && r.errs.every((v, j) => v === o.errs[j])) { byteEq++; frameEq++; }
    else if (r.bytes.every((v, j) => v === o.bytes[j])) frameEq++;
    delays.push(o.t - r.t);
  }
  delays.sort();
  const pct = p => delays[Math.min(delays.length - 1, Math.floor(p / 100 * (delays.length - 1)))];
  console.log(`逐字节一致(含错误位): ${byteEq}/${n} (${(100 * byteEq / n).toFixed(2)}%)`);
  console.log(`帧内容一致: ${frameEq}/${n} (${(100 * frameEq / n).toFixed(2)}%)`);
  if (delays.length) {
    const span = (delays[delays.length - 1] - delays[0]) * 1e3;
    console.log(`帧级延迟: 中位 ${(pct(50) * 1e3).toFixed(3)} ms  P95 ${(pct(95) * 1e3).toFixed(3)} ms  跨度 ${span.toFixed(3)} ms  负延迟 ${(100 * delays.filter(d => d < 0).length / delays.length).toFixed(1)}%`);
  }
  if (isDiy) {
    const maxAbs = Math.max(...delays.map(d => Math.abs(d))) * 1e6;
    console.log(byteEq === n ? `✅ 自研纯硬件桥: 零延迟透明透传, 逐字节100%一致, 最大时偏 ${maxAbs.toFixed(1)}µs(量化极限)。` : `⚠ 自研输出与SBUS不完全一致, 检查接线。`);
  }
}

compare('自研', sbFr, bFr, true);
if (cFr) compare(label, sbFr, cFr, false);
