# 双 UART 模块分析工具

本工具对逻辑分析仪（如 LA2016）导出的多通道 CSV 进行通配解析，自动推断
通道角色，并对两路 UART 输出分别独立解码、对比。它是**与具体协议无关的
通用双模块分析能力**，既可用来对比两块功能相同的模块，也可用来单独分析
单块模块的多路输出。

> 适用范围说明：只有当两块被测模块**功能相同、协议一致**（例如都是
> SBUS→RS-422 的透明桥，输出同为 100000 bit/s / 8E2 的 SBUS 字节流）时，
> 逐字节透传对比才有意义。若两块模块协议不同（例如一端是透明桥、
> 另一端是把 SBUS 重封装为 Modbus-RTU 的模块），它们的输出无可比性，
> 此时工具仍可对各自独立解码，但**不应**做逐帧透传对比。

## 解析能力

`src/logic-capture.js` 的 `parseLogicCaptureText`：

- 通配任意列名：列头含 `Time`/`时间` 即可，通道标签可以是 `SBUS`、
  `422+`、`淘宝422-`、`CH1`、中文或任意命名；
- 兼容 UTF-8 与 GBK/GB2312 编码（见 `docs` 中编码说明）；
- 容忍 BOM、逗号加空格分隔、空行；
- 返回 `columnLabels` 与按通道索引的 `channels`，供上层推断角色。

## 角色自动推断

`autoDetectMapping(capture)` 按标签关键字推断：

- **参考输入**：含 `sbus` / `输入` / `in` 的通道；
- **DUT-A / DUT-B 输出对**：各由一对正负通道组成，标签含
  `422+` / `422-`、`输出+` / `输出-`、`A` / `B` 等；
- 支持单组（DUT-A 自研纯硬件桥）或两组（DUT-A + DUT-B）输出。

推断结果可由 UI / CLI 参数覆盖（用户可改每路角色与信号参数）。

## 独立解码与对比

`analyzeDualModules(capture, mapping, options)` 对两路输出分别：

- 独立估算比特周期（`estimateBitPeriod`），或在用户显式指定波特率时优先使用；
- 支持可配置 `parity`（`even` / `odd` / `none`）与 `stopBits`（`1` / `2`）；
- 计算各路波特率、互补率、有效帧数、统计指标（帧率/抖动/丢帧）；
- 通过 `compareFrameSequences` 做逐帧对齐对比（仅当两路协议一致时有意义）。

## 使用方式

### Web UI

启动本地服务器后打开 `index.html`：

```bash
npm start          # python3 -m http.server 8765
# 浏览器访问 http://localhost:8765
```

1. 在「逻辑分析仪捕获（LA2016 通配格式）」上传 CSV；
2. 通道映射自动推断，可手动调整每路角色；
3. 参数区为每路选择信号参数（原 SBUS / 自定义波特率、校验、停止位）；
4. 运行分析 → 查看双模块各自指标与对比面板。

### CLI

```bash
# 单文件多通道：同一次同步采集里解码两个模块
node tools/benchmark-compare.mjs --dual <file.csv> \
  --a-baud 100000 --b-baud 100000 --a-parity even --b-parity even --a-stop 2 --b-stop 2

# 传统单 DUT / 双 DUT 模式
node tools/benchmark-compare.mjs --dut-a captures/dut-a.json --dut-a-name "DUT-A"
```

`--dual` 模式选项：

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `--a-baud` / `--b-baud` | 自动估算 | DUT-A / DUT-B 显式波特率 |
| `--a-parity` / `--b-parity` | `even` | `even` \| `odd` \| `none` |
| `--a-stop` / `--b-stop` | `2` | 停止位数 |
| `--a-name` / `--b-name` | 自动 | 模块显示名 |

报告含通道映射、各模块指标、逐帧对比（若可比）与 side-by-side 表。
报告本身就是数据摘要，**不利数据也应如实保留**。

## 测试

`tests/logic-capture-dual.test.js` 构造 LA2016 风格 5 列合成数据，
验证双模块解码、可配置参数（含 115200/8N1 场景）与逐帧对比逻辑。

```bash
npm test
```
