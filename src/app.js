import {
  SbusStreamParser,
  bytesToHex,
  calculateStats,
  captureFromJson,
  captureToJson,
  compareFrameSequences,
  encodeSbusFrame,
  uartBitsForBytes,
} from './sbus.js';
import {
  analyzeIsolatedCaptures,
  analyzeLogicCapture,
  findIndexAtOrBefore,
  getStateAt,
  parseLogicCaptureText,
} from './logic-capture.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  connect: $('#connectButton'), demo: $('#demoButton'), stop: $('#stopButton'),
  support: $('#serialSupport'), protocolSupport: $('#protocolSupport'),
  statusLight: $('#statusLight'), connectionState: $('#connectionState'),
  deviceLabel: $('#deviceLabel'), frameCount: $('#frameCount'), byteCount: $('#byteCount'),
  frameRate: $('#frameRate'), frameInterval: $('#frameInterval'), jitter: $('#jitter'),
  timingQuality: $('#timingQuality'), rejectCount: $('#rejectCount'), rejectDetail: $('#rejectDetail'),
  safetyCount: $('#safetyCount'),
  safetyDetail: $('#safetyDetail'), canvas: $('#waveform'), waveEmpty: $('#waveEmpty'),
  byteWindow: $('#byteWindow'), byteWindowLabel: $('#byteWindowLabel'), freeze: $('#freezeButton'),
  channelGrid: $('#channelGrid'), digital17: $('#digital17'), digital18: $('#digital18'),
  frameLost: $('#frameLost'), failsafe: $('#failsafe'), flagsHex: $('#flagsHex'), footerHex: $('#footerHex'),
  latestState: $('#latestFrameState'), latestTimestamp: $('#latestTimestamp'), latestHex: $('#latestHex'),
  packetRows: $('#packetRows'), protocolEvidence: $('#protocolEvidence'), protocolBadge: $('#protocolBadge'),
  compareEvidence: $('#compareEvidence'), referenceFile: $('#referenceFile'), testNote: $('#testNote'),
  exportJson: $('#exportJson'), exportCsv: $('#exportCsv'), exportReport: $('#exportReport'),
  clear: $('#clearButton'), toast: $('#toast'),
  logicCombinedFile: $('#logicCombinedFile'), logicInputFile: $('#logicInputFile'), logicOutputFile: $('#logicOutputFile'),
  logicSourceStatus: $('#logicSourceStatus'), logicModeStatus: $('#logicModeStatus'),
  logicComplement: $('#logicComplement'), logicBaud: $('#logicBaud'), logicMatch: $('#logicMatch'),
  logicDelay: $('#logicDelay'), logicResult: $('#logicResult'), logicSpan: $('#logicSpan'),
  logicPosition: $('#logicPosition'), logicCanvas: $('#logicWaveform'), logicEmpty: $('#logicEmpty'),
};

const state = {
  mode: 'idle',
  records: [],
  reference: [],
  totalBytes: 0,
  port: null,
  reader: null,
  reading: false,
  demoTimer: null,
  sessionStart: performance.now(),
  device: '等待设备',
  frozen: false,
  frozenFrame: null,
  renderQueued: false,
  batchedReads: 0,
  logicCombined: null,
  logicInput: null,
  logicOutput: null,
  logicAnalysis: null,
};

const parser = new SbusStreamParser();

function createChannelRows() {
  ui.channelGrid.innerHTML = Array.from({ length: 16 }, (_, index) => `
    <div class="channel">
      <div class="channel-head"><span>CH${String(index + 1).padStart(2, '0')}</span><strong id="chValue${index}">—</strong></div>
      <div class="channel-track"><i id="chBar${index}"></i></div>
    </div>`).join('');
}

function setMode(mode, device = state.device) {
  state.mode = mode;
  state.device = device;
  const active = mode === 'serial' || mode === 'demo';
  ui.connect.hidden = active;
  ui.demo.hidden = active;
  ui.stop.hidden = !active;
  ui.statusLight.className = mode === 'serial' ? 'live' : mode === 'demo' ? 'demo' : '';
  ui.connectionState.textContent = mode === 'serial' ? '实时采集中' : mode === 'demo' ? '演示信号' : '未连接';
  ui.deviceLabel.textContent = device;
  scheduleRender();
}

function resetCapture() {
  state.records = [];
  state.totalBytes = 0;
  state.batchedReads = 0;
  state.sessionStart = performance.now();
  state.frozenFrame = null;
  parser.reset();
  scheduleRender();
}

function acceptChunk(chunk, arrival = performance.now()) {
  state.totalBytes += chunk.length;
  const parsed = parser.push(chunk, arrival);
  if (!parsed.length) {
    scheduleRender();
    return;
  }

  const arrivalRelative = arrival - state.sessionStart;
  const lastTimestamp = state.records.at(-1)?.timestamp;
  let timestamps;
  if (parsed.length === 1) {
    timestamps = [arrivalRelative];
  } else {
    state.batchedReads += 1;
    const span = Number.isFinite(lastTimestamp) && arrivalRelative > lastTimestamp
      ? arrivalRelative - lastTimestamp
      : parsed.length * 3;
    const step = span / parsed.length;
    timestamps = parsed.map((_, index) => Number.isFinite(lastTimestamp)
      ? lastTimestamp + step * (index + 1)
      : arrivalRelative - step * (parsed.length - index - 1));
  }

  parsed.forEach((frame, index) => {
    const record = {
      ...frame,
      timestamp: timestamps[index],
      arrivalTimestamp: arrivalRelative,
      timingEstimated: parsed.length > 1,
    };
    state.records.push(record);
    if (!state.frozen) state.frozenFrame = record;
  });
  if (state.records.length > 10000) state.records.splice(0, state.records.length - 10000);
  scheduleRender();
}

async function connectSerial() {
  if (!('serial' in navigator)) {
    showToast('当前浏览器不支持 Web Serial。请用 Chrome 或 Edge，通过 localhost 打开。');
    return;
  }
  try {
    const grantedPorts = await navigator.serial.getPorts();
    const port = grantedPorts.length === 1 ? grantedPorts[0] : await navigator.serial.requestPort();
    await port.open({ baudRate: 100000, dataBits: 8, stopBits: 2, parity: 'even', flowControl: 'none', bufferSize: 65536 });
    resetCapture();
    state.port = port;
    state.reading = true;
    const info = port.getInfo?.() ?? {};
    const ids = [info.usbVendorId && `VID ${hex4(info.usbVendorId)}`, info.usbProductId && `PID ${hex4(info.usbProductId)}`].filter(Boolean).join(' · ');
    setMode('serial', ids || 'USB 串口 · 100000 8E2');
    readSerialLoop();
  } catch (error) {
    if (error?.name !== 'NotFoundError') showToast(`串口连接失败：${error.message}`);
  }
}

async function readSerialLoop() {
  try {
    while (state.port?.readable && state.reading) {
      const reader = state.port.readable.getReader();
      state.reader = reader;
      try {
        while (state.reading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) acceptChunk(value);
        }
      } finally {
        reader.releaseLock();
        if (state.reader === reader) state.reader = null;
      }
    }
  } catch (error) {
    if (state.reading) showToast(`串口读取中断：${error.message}`);
  } finally {
    if (state.mode === 'serial') await stopCapture();
  }
}

async function stopCapture() {
  if (state.demoTimer) {
    clearInterval(state.demoTimer);
    state.demoTimer = null;
  }
  state.reading = false;
  try { await state.reader?.cancel(); } catch { /* already closed */ }
  const portToClose = state.port;
  state.port = null;
  if (portToClose) {
    // Let the read loop release its lock before closing the underlying port.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await portToClose.close();
    } catch {
      setTimeout(() => portToClose.close().catch(() => {}), 50);
    }
  }
  setMode('idle', state.records.length ? '采集已停止 · 数据已保留' : '等待设备');
}

function startDemo() {
  resetCapture();
  setMode('demo', '内置 SBUS 仿真 · 约 71 Hz');
  let tick = 0;
  const emit = () => {
    const channels = Array.from({ length: 16 }, (_, index) => {
      const phase = tick * (0.032 + index * 0.0008) + index * 0.51;
      return Math.round(992 + Math.sin(phase) * (index < 4 ? 780 : 420));
    });
    const frame = encodeSbusFrame(channels, {
      digital17: Math.floor(tick / 70) % 2 === 1,
      digital18: Math.floor(tick / 140) % 2 === 1,
    });
    acceptChunk(frame);
    tick += 1;
  };
  emit();
  state.demoTimer = setInterval(emit, 14);
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    render();
  });
}

function render() {
  const latest = state.frozen ? state.frozenFrame : state.records.at(-1);
  const stats = calculateStats(state.records, parser.rejectedBytes);
  ui.frameCount.textContent = stats.frames.toLocaleString('zh-CN');
  ui.byteCount.textContent = `${state.totalBytes.toLocaleString('zh-CN')} bytes`;
  ui.frameRate.textContent = stats.frameRate ? stats.frameRate.toFixed(2) : '—';
  ui.frameInterval.textContent = stats.meanInterval ? `周期 ${stats.meanInterval.toFixed(3)} ms` : '周期 — ms';
  ui.jitter.textContent = stats.frames > 2 ? stats.jitter.toFixed(3) : '—';
  ui.timingQuality.textContent = state.batchedReads ? `${state.batchedReads} 次 USB 批量到达，间隔含估算` : 'USB 到达时间（非硬件时间戳）';
  ui.rejectCount.textContent = stats.rejectedBytes.toLocaleString('zh-CN');
  ui.rejectDetail.textContent = parser.hasEverSynchronized
    ? `运行期丢弃字节 · 初始对齐 ${parser.acquisitionBytes}`
    : `运行期丢弃字节 · 等待首次同步（已跳过 ${parser.acquisitionBytes}）`;
  ui.safetyCount.textContent = (stats.lostFrames + stats.failsafeFrames).toLocaleString('zh-CN');
  ui.safetyDetail.textContent = `Lost ${stats.lostFrames} · Failsafe ${stats.failsafeFrames}`;
  renderProtocolState();

  renderLatest(latest);
  renderChannels(latest);
  renderPackets();
  renderEvidence(stats);
  drawWaveform(latest);
  renderLogicCapture();
}

function renderProtocolState() {
  const labels = {
    sbus: '标准 SBUS · 已锁定',
    sbus2: 'SBUS2 · 已锁定',
    unknown: '协议待识别',
  };
  ui.protocolSupport.textContent = labels[parser.protocol] ?? labels.unknown;
  ui.protocolSupport.className = `support-tag${parser.protocol === 'unknown' ? '' : ' good'}`;
}

function renderLatest(frame) {
  if (!frame) {
    ui.latestState.className = 'state-chip neutral';
    ui.latestState.textContent = '等待帧';
    ui.latestTimestamp.textContent = '— ms';
    ui.waveEmpty.hidden = false;
    return;
  }
  ui.latestState.className = 'state-chip good';
  ui.latestState.textContent = '帧结构有效';
  ui.latestTimestamp.textContent = `${frame.timestamp.toFixed(3)} ms`;
  ui.latestHex.innerHTML = Array.from(frame.bytes, (byte, index) => {
    const cls = index === 0 ? 'header-byte' : index === 23 ? 'flag-byte' : index === 24 ? 'footer-byte' : '';
    return `<span class="${cls}">${byte.toString(16).padStart(2, '0').toUpperCase()}</span>`;
  }).join(' ');
  ui.waveEmpty.hidden = true;
}

function renderChannels(frame) {
  for (let index = 0; index < 16; index += 1) {
    const value = frame?.channels[index];
    $(`#chValue${index}`).textContent = Number.isFinite(value) ? value : '—';
    $(`#chBar${index}`).style.width = Number.isFinite(value) ? `${value / 2047 * 100}%` : '0%';
  }
  setFlag(ui.digital17, frame?.digital17, 'HIGH', 'LOW', false);
  setFlag(ui.digital18, frame?.digital18, 'HIGH', 'LOW', false);
  setFlag(ui.frameLost, frame?.frameLost, 'YES', 'NO', true);
  setFlag(ui.failsafe, frame?.failsafe, 'YES', 'NO', true);
  ui.flagsHex.textContent = `0x${(frame?.flags ?? 0).toString(16).padStart(2, '0').toUpperCase()}`;
  ui.footerHex.textContent = `0x${(frame?.footer ?? 0).toString(16).padStart(2, '0').toUpperCase()}`;
}

function setFlag(element, active, onText, offText, danger) {
  element.textContent = active ? onText : offText;
  element.className = danger ? (active ? 'bad' : 'ok') : (active ? 'ok' : '');
}

function renderPackets() {
  if (!state.records.length) {
    ui.packetRows.innerHTML = '<tr class="empty-row"><td colspan="5">暂无数据</td></tr>';
    return;
  }
  const start = Math.max(0, state.records.length - 30);
  ui.packetRows.innerHTML = state.records.slice(start).map((record, localIndex) => {
    const index = start + localIndex;
    const delta = index ? record.timestamp - state.records[index - 1].timestamp : 0;
    const warning = record.frameLost || record.failsafe;
    const preview = bytesToHex(record.bytes.slice(0, 8));
    return `<tr>
      <td>${index + 1}</td><td>${record.timestamp.toFixed(2)}</td><td>${index ? delta.toFixed(3) : '—'}</td>
      <td class="${warning ? 'warn-text' : 'good-text'}">${warning ? 'FLAG' : 'VALID'}</td><td title="${bytesToHex(record.bytes)}">${preview} …</td>
    </tr>`;
  }).reverse().join('');
}

function renderEvidence(stats) {
  if (!stats.frames && state.logicAnalysis?.outputFrames.length) {
    ui.protocolEvidence.textContent = `逻辑采集输出侧已解析 ${state.logicAnalysis.outputFrames.length} 个有效 SBUS 帧`;
    ui.protocolBadge.className = 'result-badge pass';
    ui.protocolBadge.textContent = '通过';
  } else if (!stats.frames) {
    ui.protocolEvidence.textContent = '等待有效 SBUS 帧';
    ui.protocolBadge.className = 'result-badge waiting';
    ui.protocolBadge.textContent = '待测';
  } else if (parser.rejectedCandidates > 0 || parser.rejectedBytes > 0) {
    ui.protocolEvidence.textContent = `${stats.frames} 帧结构有效；运行期丢弃 ${parser.rejectedBytes} 字节，发现 ${parser.rejectedCandidates} 个异常候选帧`;
    ui.protocolBadge.className = 'result-badge fail';
    ui.protocolBadge.textContent = '需检查';
  } else if (stats.frames < 10) {
    ui.protocolEvidence.textContent = `已连续解析 ${stats.frames} 帧；至少采集 10 帧后给出结论`;
    ui.protocolBadge.className = 'result-badge waiting';
    ui.protocolBadge.textContent = '采集中';
  } else {
    const protocol = parser.protocol === 'sbus2' ? 'SBUS2' : '标准 SBUS';
    ui.protocolEvidence.textContent = `${stats.frames} 帧连续满足 ${protocol} 帧头、25 字节长度和帧尾规则；运行期同步错误 0（初始对齐 ${parser.acquisitionBytes} 字节）`;
    ui.protocolBadge.className = 'result-badge pass';
    ui.protocolBadge.textContent = '通过';
  }

  if (state.logicAnalysis?.frameComparison.comparable) {
    const comparison = state.logicAnalysis.frameComparison;
    const rate = (comparison.matchRate * 100).toFixed(2);
    const source = state.logicAnalysis.synchronized ? '逻辑分析仪同步单文件' : '逻辑分析仪隔离分次采集';
    ui.compareEvidence.textContent = `${source}自动偏移 ${signed(comparison.offset)} 帧；${comparison.matched}/${comparison.comparable} 帧逐字节一致（${rate}%）`;
  } else if (state.reference.length && state.records.length) {
    const comparison = compareFrameSequences(state.reference, state.records);
    const rate = (comparison.matchRate * 100).toFixed(2);
    ui.compareEvidence.textContent = `自动偏移 ${signed(comparison.offset)} 帧；${comparison.matched}/${comparison.comparable} 帧逐字节一致（${rate}%）`;
  } else if (state.reference.length) {
    ui.compareEvidence.textContent = `已载入 ${state.reference.length} 个参考帧，等待模块输出数据`;
  } else {
    ui.compareEvidence.textContent = '导入模块输入侧的参考捕获，自动对齐并比较完整 25 字节帧';
  }
}

async function importLogicCapture(event, side) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (!/\.(csv|txt)$/i.test(file.name)) throw new Error('请选择符合项目交换格式的 CSV 或 TXT 原始数字采样文件');
    const capture = parseLogicCaptureText(await readLogicText(file), file.name);
    if (side === 'combined' && (!capture.channels[0] || !capture.channels[1] || !capture.channels[2])) {
      throw new Error('同步文件必须同时包含 CH0、CH1 和 CH2');
    }
    if (side === 'input' && !capture.channels[0]) throw new Error('输入侧文件必须包含 CH0');
    if (side === 'output' && (!capture.channels[1] || !capture.channels[2])) throw new Error('输出侧文件必须包含 CH1 和 CH2');
    if (side === 'combined') {
      state.logicCombined = capture;
      state.logicInput = null;
      state.logicOutput = null;
      state.logicAnalysis = analyzeLogicCapture(capture);
    } else {
      if (state.logicCombined) {
        state.logicCombined = null;
        state.logicInput = null;
        state.logicOutput = null;
      }
      if (side === 'input') state.logicInput = capture;
      else state.logicOutput = capture;
      state.logicAnalysis = state.logicInput && state.logicOutput
        ? analyzeIsolatedCaptures(state.logicInput, state.logicOutput)
        : null;
    }
    ui.logicPosition.value = '0';
    const label = side === 'combined' ? '同步三通道' : side === 'input' ? '输入侧' : '输出侧';
    showToast(`已载入${label}捕获：${file.name}`);
    scheduleRender();
  } catch (error) {
    showToast(`逻辑采集文件无法读取：${error.message}`);
  } finally {
    event.target.value = '';
  }
}

async function readLogicText(file) {
  return file.text();
}

function renderLogicCapture() {
  if (state.logicCombined) {
    ui.logicSourceStatus.textContent = `${state.logicCombined.fileName} · ${state.logicCombined.sourceRows.toLocaleString()} 行 · ${(state.logicCombined.duration * 1000).toFixed(3)} ms`;
    ui.logicModeStatus.textContent = '同步单 CSV · 共同时间轴';
  } else if (state.logicInput || state.logicOutput) {
    const input = state.logicInput ? `CH0 ${state.logicInput.fileName}` : 'CH0 待导入';
    const output = state.logicOutput ? `CH1/CH2 ${state.logicOutput.fileName}` : 'CH1/CH2 待导入';
    ui.logicSourceStatus.textContent = `${input} / ${output}`;
    ui.logicModeStatus.textContent = state.logicAnalysis ? '隔离双文件 · 按帧内容对齐' : '隔离双文件 · 等待另一侧';
  } else {
    ui.logicSourceStatus.textContent = '等待 CSV/TXT';
    ui.logicModeStatus.textContent = '同步单文件优先';
  }
  [ui.logicComplement, ui.logicBaud, ui.logicMatch, ui.logicDelay].forEach((element) => { element.className = ''; });

  const analysis = state.logicAnalysis;
  if (!analysis) {
    ui.logicComplement.textContent = '—';
    ui.logicBaud.textContent = '—';
    ui.logicMatch.textContent = '—';
    ui.logicDelay.textContent = state.logicInput || state.logicOutput ? '分次采集不可测' : '等待同步捕获';
    ui.logicResult.textContent = state.logicInput || state.logicOutput
      ? '已载入一侧捕获，请继续导入另一侧文件。'
      : '导入同时包含 Time、CH0、CH1、CH2 的原始数字采样 CSV/TXT。';
  } else {
    const comparison = analysis.frameComparison;
    ui.logicComplement.textContent = `${(analysis.complementRate * 100).toFixed(4)}%`;
    ui.logicComplement.className = analysis.complementRate >= 0.999 ? 'pass' : 'warn';
    ui.logicBaud.textContent = `${analysis.inputBaudRate.toFixed(1)} / ${analysis.outputBaudRate.toFixed(1)}`;
    ui.logicBaud.className = analysis.baudDifferenceRate <= 0.001 ? 'pass' : 'warn';
    ui.logicMatch.textContent = comparison.comparable
      ? `${comparison.matched}/${comparison.comparable} · ${(comparison.matchRate * 100).toFixed(2)}%`
      : '未找到可对齐帧';
    ui.logicMatch.className = comparison.comparable && comparison.matchRate === 1 ? 'pass' : 'warn';
    if (analysis.propagationDelayAvailable) {
      ui.logicDelay.textContent = analysis.delays.samples
        ? `${formatMicroseconds(analysis.delays.median)} / ${formatMicroseconds(analysis.delays.p95Absolute)}`
        : '未匹配到对应边沿';
      ui.logicDelay.className = analysis.delays.samples ? 'pass' : 'warn';
      ui.logicResult.textContent = `${analysis.delays.polarity}；共同时间轴匹配 ${analysis.delays.samples} 个边沿，映射率 ${(analysis.mappingRate * 100).toFixed(4)}%；输入/输出 ${analysis.inputFrames.length}/${analysis.outputFrames.length} 帧，UART 边界无效字符 ${analysis.inputUart.invalidFrames.length}/${analysis.outputUart.invalidFrames.length}。`;
    } else {
      ui.logicDelay.textContent = '分次采集不可测';
      ui.logicDelay.className = '';
      ui.logicResult.textContent = `${analysis.polarity}；输入解析 ${analysis.inputFrames.length} 帧，输出解析 ${analysis.outputFrames.length} 帧，自动偏移 ${signed(comparison.offset)} 帧。`;
    }
  }
  drawLogicCapture();
}

function drawLogicCapture() {
  const canvas = ui.logicCanvas;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = 292;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const hasCapture = Boolean(state.logicCombined || state.logicInput || state.logicOutput);
  ui.logicEmpty.hidden = hasCapture;
  if (!hasCapture) return;

  const synchronous = Boolean(state.logicCombined);
  const inputCapture = state.logicCombined ?? state.logicInput;
  const outputCapture = state.logicCombined ?? state.logicOutput;

  const styles = getComputedStyle(document.documentElement);
  const colors = {
    input: styles.getPropertyValue('--warn').trim(),
    positive: styles.getPropertyValue('--signal').trim(),
    negative: styles.getPropertyValue('--cyan').trim(),
    text: styles.getPropertyValue('--text').trim(),
    muted: styles.getPropertyValue('--muted').trim(),
    faint: styles.getPropertyValue('--faint').trim(),
    line: styles.getPropertyValue('--line').trim(),
  };
  const left = Math.min(135, width * 0.3);
  const right = 18;
  const plotWidth = Math.max(100, width - left - right);
  const span = Number(ui.logicSpan.value);
  const anchors = logicCaptureAnchors();
  const inputAvailable = inputCapture ? Math.max(0, inputCapture.duration - anchors.input) : 0;
  const outputAvailable = outputCapture ? Math.max(0, outputCapture.duration - anchors.output) : 0;
  const available = Math.max(inputAvailable, outputAvailable, span);
  const viewStart = Number(ui.logicPosition.value) / 1000 * Math.max(0, available - span);

  ctx.font = '10px SFMono-Regular, Consolas, monospace';
  ctx.textBaseline = 'middle';
  const inputDetail = synchronous ? '同步采集 · 共同时间轴' : '输入侧独立采集';
  const outputDetail = synchronous ? '同步采集 · 共同时间轴' : '输出侧独立采集';
  const lanes = [
    { label: 'CH0  SBUS IN', detail: inputDetail, capture: inputCapture, channel: 0, anchor: anchors.input, high: 37, low: 76, color: colors.input },
    { label: 'CH1  422+', detail: outputDetail, capture: outputCapture, channel: 1, anchor: anchors.output, high: 117, low: 156, color: colors.positive },
    { label: 'CH2  422−', detail: outputDetail, capture: outputCapture, channel: 2, anchor: anchors.output, high: 197, low: 236, color: colors.negative },
  ];
  lanes.forEach((lane) => {
    ctx.fillStyle = colors.text;
    ctx.fillText(lane.label, 17, lane.high + 12);
    ctx.fillStyle = colors.muted;
    ctx.fillText(lane.detail, 17, lane.high + 29);
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    [lane.high, lane.low].forEach((y) => {
      ctx.beginPath(); ctx.moveTo(left, y + .5); ctx.lineTo(width - right, y + .5); ctx.stroke();
    });
    if (lane.capture?.channels[lane.channel]) {
      drawCapturedLane(ctx, lane.capture, lane.channel, lane.anchor + viewStart, lane.anchor + viewStart + span, left, plotWidth, lane.high, lane.low, lane.color);
    }
  });

  ctx.fillStyle = colors.faint;
  ctx.textAlign = 'left';
  ctx.fillText(`${(viewStart * 1000).toFixed(3)} ms`, left, 265);
  ctx.textAlign = 'right';
  ctx.fillText(`${((viewStart + span) * 1000).toFixed(3)} ms`, width - right, 265);
  ctx.textAlign = 'center';
  const timeLabel = synchronous
    ? '单文件共同时间轴 · 保留真实传播延迟'
    : state.logicAnalysis ? '相同 SBUS 帧内容对齐后的相对时间' : '各捕获文件自身的相对时间';
  ctx.fillText(timeLabel, left + plotWidth / 2, 281);
  ctx.textAlign = 'left';
}

function drawCapturedLane(ctx, capture, channel, start, end, left, plotWidth, yHigh, yLow, color) {
  const values = capture.channels[channel];
  let index = Math.max(0, findIndexAtOrBefore(capture.times, start));
  const firstValue = getStateAt(capture, start, channel);
  let previousY = firstValue ? yHigh : yLow;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  ctx.beginPath();
  ctx.moveTo(left, previousY);
  index += 1;
  let transitions = 0;
  while (index < capture.times.length && capture.times[index] <= end && transitions < 50000) {
    const x = left + (capture.times[index] - start) / (end - start) * plotWidth;
    const nextY = values[index] ? yHigh : yLow;
    ctx.lineTo(x, previousY);
    ctx.lineTo(x, nextY);
    previousY = nextY;
    index += 1;
    transitions += 1;
  }
  ctx.lineTo(left + plotWidth, previousY);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function logicCaptureAnchors() {
  if (state.logicCombined) return { input: 0, output: 0 };
  const analysis = state.logicAnalysis;
  if (!analysis?.inputFrames.length || !analysis.outputFrames.length) return { input: 0, output: 0 };
  const offset = analysis.frameComparison.offset;
  const inputIndex = Math.max(0, -offset);
  const outputIndex = Math.max(0, offset);
  const characterLead = 24 * 12 * 10e-6;
  return {
    input: Math.max(0, analysis.inputFrames[inputIndex]?.timestamp / 1000 - characterLead),
    output: Math.max(0, analysis.outputFrames[outputIndex]?.timestamp / 1000 - characterLead),
  };
}

function drawWaveform(frame) {
  const canvas = ui.canvas;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = 250;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!frame) return;

  const styles = getComputedStyle(document.documentElement);
  const signal = styles.getPropertyValue('--signal').trim();
  const cyan = styles.getPropertyValue('--cyan').trim();
  const muted = styles.getPropertyValue('--muted').trim();
  const faint = styles.getPropertyValue('--faint').trim();
  const line = styles.getPropertyValue('--line').trim();
  const text = styles.getPropertyValue('--text').trim();
  const startByte = Number(ui.byteWindow.value);
  const bytes = frame.bytes.slice(startByte, startByte + 4);
  const bits = uartBitsForBytes(bytes);
  const left = Math.min(122, width * 0.27);
  const right = 18;
  const plotWidth = Math.max(100, width - left - right);
  const bitWidth = plotWidth / bits.length;

  ctx.font = '10px SFMono-Regular, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = text;
  ctx.fillText('USB-UART', 17, 67);
  ctx.fillStyle = muted;
  ctx.fillText('解码侧', 17, 84);
  ctx.fillStyle = text;
  ctx.fillText('SBUS', 17, 159);
  ctx.fillStyle = muted;
  ctx.fillText('反相推导', 17, 176);

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  [43, 91, 135, 183].forEach((y) => {
    ctx.beginPath(); ctx.moveTo(left, y + .5); ctx.lineTo(width - right, y + .5); ctx.stroke();
  });

  for (let byteIndex = 0; byteIndex <= bytes.length; byteIndex += 1) {
    const x = left + byteIndex * 12 * bitWidth;
    ctx.strokeStyle = byteIndex === 0 || byteIndex === bytes.length ? line : `${faint}88`;
    ctx.setLineDash(byteIndex === 0 || byteIndex === bytes.length ? [] : [3, 4]);
    ctx.beginPath(); ctx.moveTo(x, 25); ctx.lineTo(x, 203); ctx.stroke();
    if (byteIndex < bytes.length) {
      ctx.fillStyle = muted;
      ctx.textAlign = 'center';
      ctx.fillText(`B${startByte + byteIndex}  ${bytes[byteIndex].toString(16).padStart(2, '0').toUpperCase()}`, x + bitWidth * 6, 15);
    }
  }
  ctx.setLineDash([]);
  drawLogicPath(ctx, bits, left, bitWidth, 43, 91, signal, false);
  drawLogicPath(ctx, bits, left, bitWidth, 135, 183, cyan, true);

  ctx.fillStyle = faint;
  ctx.textAlign = 'left';
  ctx.fillText(`${startByte * 120} μs`, left, 224);
  ctx.textAlign = 'right';
  ctx.fillText(`${(startByte + bytes.length) * 120} μs`, width - right, 224);
  ctx.textAlign = 'center';
  ctx.fillText('帧内时间（按 100 kbit/s 推导）', left + plotWidth / 2, 239);
  ctx.textAlign = 'left';
}

function drawLogicPath(ctx, bits, left, bitWidth, yHigh, yLow, color, invert) {
  const values = invert ? bits.map((bit) => 1 - bit) : bits;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  ctx.beginPath();
  let previousY = values[0] ? yHigh : yLow;
  ctx.moveTo(left, previousY);
  values.forEach((bit, index) => {
    const y = bit ? yHigh : yLow;
    const x = left + index * bitWidth;
    if (index) { ctx.lineTo(x, previousY); ctx.lineTo(x, y); }
    ctx.lineTo(x + bitWidth, y);
    previousY = y;
  });
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function exportCapture() {
  if (!ensureRecords()) return;
  const capture = captureToJson(state.records, metadata());
  download(JSON.stringify(capture, null, 2), filename('capture', 'json'), 'application/json');
}

function exportCsv() {
  if (!ensureRecords()) return;
  const header = ['frame', 'timestamp_ms', 'delta_ms', ...Array.from({ length: 16 }, (_, i) => `ch${i + 1}`), 'ch17', 'ch18', 'frame_lost', 'failsafe', 'flags_hex', 'footer_hex', 'frame_hex'];
  const rows = state.records.map((record, index) => {
    const delta = index ? record.timestamp - state.records[index - 1].timestamp : '';
    return [index + 1, record.timestamp.toFixed(3), delta === '' ? '' : delta.toFixed(3), ...record.channels,
      Number(record.digital17), Number(record.digital18), Number(record.frameLost), Number(record.failsafe),
      hex2(record.flags), hex2(record.footer), `"${bytesToHex(record.bytes)}"`].join(',');
  });
  download(`\uFEFF${[header.join(','), ...rows].join('\n')}`, filename('frames', 'csv'), 'text/csv;charset=utf-8');
}

function exportReport() {
  if (!state.records.length && !state.logicAnalysis) {
    showToast('当前没有串口数据或完整的逻辑分析捕获');
    return;
  }
  const stats = calculateStats(state.records, parser.rejectedBytes);
  const logic = state.logicAnalysis;
  const comparison = logic?.frameComparison ?? (state.reference.length ? compareFrameSequences(state.reference, state.records) : null);
  const note = escapeHtml(ui.testNote.value.trim() || '未填写');
  const logicSource = logic?.synchronized ? '逻辑分析仪同步单文件捕获' : '逻辑分析仪输入/输出侧分次捕获';
  const compareText = comparison
    ? `${comparison.matched}/${comparison.comparable} 帧一致（${(comparison.matchRate * 100).toFixed(2)}%），自动偏移 ${signed(comparison.offset)} 帧${logic ? `；来源为 ${logicSource}` : ''}`
    : '未导入输入侧参考捕获，无法给出逐字节“不改变”结论';
  const delayMedian = logic?.propagationDelayAvailable && logic.delays.samples ? formatMicroseconds(logic.delays.median) : '不可测';
  const delayP95 = logic?.propagationDelayAvailable && logic.delays.samples ? formatMicroseconds(logic.delays.p95Absolute) : '不可测';
  const logicNote = logic?.synchronized
    ? `输出极性：${logic.delays.polarity}。CH0、CH1、CH2 来自同一文件和共同时间轴；传播延迟统计使用 ${logic.delays.samples} 个对应边沿。`
    : logic ? `输出极性：${logic.polarity}。输入侧与输出侧为保持电气隔离而分次采集，本结果不包含传播延迟；波形仅按相同 SBUS 帧内容对齐。` : '';
  const logicSection = logic ? `<h2>逻辑分析仪${logic.synchronized ? '同步时域分析' : '隔离双文件分析'}</h2><table><tr><th>输入有效帧</th><th>输出有效帧</th><th>422 互补率</th><th>输入波特率</th><th>输出波特率</th><th>延迟中位数</th><th>延迟 P95</th></tr><tr><td>${logic.inputFrames.length}</td><td>${logic.outputFrames.length}</td><td>${(logic.complementRate * 100).toFixed(4)}%</td><td>${logic.inputBaudRate.toFixed(2)}</td><td>${logic.outputBaudRate.toFixed(2)}</td><td>${delayMedian}</td><td>${delayP95}</td></tr></table><p>${logicNote}</p>` : '';
  const report = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>SBUS/422 验证报告</title>
  <style>body{max-width:980px;margin:48px auto;padding:0 28px;color:#1c2523;font:14px/1.65 system-ui}h1{font-size:25px}h2{margin-top:32px;font-size:17px;border-bottom:1px solid #ccd5d2;padding-bottom:8px}table{width:100%;border-collapse:collapse}td,th{padding:9px;border:1px solid #ccd5d2;text-align:left}th{background:#f0f5f3}code{font-family:monospace}.pass{color:#087a50}.warn{color:#9b6110}.note{padding:14px;background:#f4f7f6;border-left:4px solid #5d776f}footer{margin-top:38px;color:#61706c;font-size:12px}@media print{body{margin:0}}</style>
  <body><h1>SBUS 转 RS-422 模块验证报告</h1><p>生成时间：${new Date().toLocaleString('zh-CN')}<br>测试备注：${note}</p>
  <h2>串口配置</h2><table><tr><th>接口</th><th>波特率</th><th>数据格式</th><th>设备</th></tr><tr><td>USB 串口</td><td>100000 bit/s</td><td>8 data · Even parity · 2 stop</td><td>${escapeHtml(state.device)}</td></tr></table>
  <h2>采集结果</h2><table><tr><th>协议</th><th>有效帧</th><th>帧率</th><th>平均周期</th><th>到达抖动 σ</th><th>运行期同步异常</th><th>初始对齐字节</th></tr><tr><td>${parser.protocol === 'sbus2' ? 'SBUS2' : parser.protocol === 'sbus' ? '标准 SBUS' : '待识别'}</td><td>${stats.frames}</td><td>${stats.frameRate.toFixed(3)} Hz</td><td>${stats.meanInterval.toFixed(3)} ms</td><td>${stats.jitter.toFixed(3)} ms</td><td>${stats.rejectedBytes}</td><td>${parser.acquisitionBytes}</td></tr></table>
  <h2>协议与数据结论</h2><p class="${parser.rejectedCandidates || parser.rejectedBytes ? 'warn' : 'pass'}">协议结构：${parser.rejectedCandidates || parser.rejectedBytes ? `运行期丢弃 ${parser.rejectedBytes} 字节并发现 ${parser.rejectedCandidates} 个异常候选帧，请复核原始捕获。` : `${stats.frames ? `串口连续 ${stats.frames} 帧` : `逻辑采集输出 ${logic?.outputFrames.length ?? 0} 帧`}满足帧头、长度和已知帧尾规则；连接时初始对齐 ${parser.acquisitionBytes} 字节不计为运行期错误。`}</p><p>输入/输出逐字节对比：${compareText}</p>${logicSection}
  <h2>安全标志</h2><p>FRAME LOST：${stats.lostFrames} 帧；FAILSAFE：${stats.failsafeFrames} 帧。</p>
  <h2>测量边界</h2><p class="note">USB 串口区域的逻辑波形和位时间由解码字节按 100 kbit/s、8E2 重建。${logic?.synchronized ? '同步单文件模式使用 CH0、CH1、CH2 的共同时间轴，可分析数字边沿传播延迟；采集前必须确认测试接地不会破坏隔离或安全要求。' : '隔离双文件模式只按相同 SBUS 帧内容对齐，不能据此计算传播延迟。'}逻辑分析仪不能替代差分示波器验证 RS-422 幅值、共模范围和模拟边沿。</p>
  ${state.records.length ? `<h2>最近一帧</h2><code>${bytesToHex(state.records.at(-1).bytes)}</code>` : ''}<footer>SBUS / 422 Signal Lab · 本报告应与原始捕获文件和示波器截图一并归档。</footer></body></html>`;
  download(report, filename('verification-report', 'html'), 'text/html;charset=utf-8');
}

async function importReference(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    state.reference = captureFromJson(await file.text());
    showToast(`已载入 ${state.reference.length} 个参考帧：${file.name}`);
    scheduleRender();
  } catch (error) {
    showToast(`参考捕获无法读取：${error.message}`);
  } finally {
    event.target.value = '';
  }
}

function metadata() {
  return {
    mode: state.mode,
    device: state.device,
    protocol: parser.protocol,
    acquisitionBytes: parser.acquisitionBytes,
    runtimeRejectedBytes: parser.rejectedBytes,
    note: ui.testNote.value.trim(),
    timing: 'USB arrival timestamps; batched frames may be estimated',
  };
}

function ensureRecords() {
  if (state.records.length) return true;
  showToast('当前没有可导出的完整 SBUS 帧');
  return false;
}

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer;
function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3600);
}

function hex2(value) { return `0x${value.toString(16).padStart(2, '0').toUpperCase()}`; }
function hex4(value) { return value.toString(16).padStart(4, '0').toUpperCase(); }
function signed(value) { return value > 0 ? `+${value}` : String(value); }
function formatMicroseconds(seconds) { return `${(seconds * 1e6).toFixed(3)} µs`; }
function filename(prefix, extension) { return `sbus-${prefix}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${extension}`; }
function escapeHtml(text) { return text.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

ui.connect.addEventListener('click', connectSerial);
ui.demo.addEventListener('click', startDemo);
ui.stop.addEventListener('click', stopCapture);
ui.clear.addEventListener('click', resetCapture);
ui.exportJson.addEventListener('click', exportCapture);
ui.exportCsv.addEventListener('click', exportCsv);
ui.exportReport.addEventListener('click', exportReport);
ui.referenceFile.addEventListener('change', importReference);
ui.logicCombinedFile.addEventListener('change', (event) => importLogicCapture(event, 'combined'));
ui.logicInputFile.addEventListener('change', (event) => importLogicCapture(event, 'input'));
ui.logicOutputFile.addEventListener('change', (event) => importLogicCapture(event, 'output'));
ui.logicSpan.addEventListener('change', drawLogicCapture);
ui.logicPosition.addEventListener('input', drawLogicCapture);
ui.byteWindow.addEventListener('input', () => {
  const start = Number(ui.byteWindow.value);
  ui.byteWindowLabel.textContent = `B${start}–B${start + 3}`;
  drawWaveform(state.frozen ? state.frozenFrame : state.records.at(-1));
});
ui.freeze.addEventListener('click', () => {
  state.frozen = !state.frozen;
  if (state.frozen) state.frozenFrame = state.records.at(-1) ?? null;
  ui.freeze.setAttribute('aria-pressed', String(state.frozen));
  ui.freeze.textContent = state.frozen ? '继续' : '冻结';
  scheduleRender();
});

if ('serial' in navigator && window.isSecureContext) {
  ui.support.textContent = 'WEB SERIAL 可用';
  ui.support.className = 'support-tag good';
  navigator.serial.addEventListener?.('disconnect', (event) => {
    if (event.target === state.port) {
      showToast('USB 串口已断开');
      stopCapture();
    }
  });
} else {
  ui.support.textContent = '需 Chrome / Edge · localhost';
  ui.support.className = 'support-tag bad';
  ui.connect.title = 'Web Serial 需要 Chrome/Edge 且页面必须通过 localhost 或 HTTPS 打开';
}

createChannelRows();
new ResizeObserver(() => drawWaveform(state.frozen ? state.frozenFrame : state.records.at(-1))).observe(ui.canvas);
new ResizeObserver(drawLogicCapture).observe(ui.logicCanvas);
render();
