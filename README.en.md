# SBUS-RS422 Bridge

[![CI](https://github.com/Sailiono/sbus-rs422-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Sailiono/sbus-rs422-bridge/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-15%20passing-brightgreen)](#testing)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#)
[![Hardware: CERN-OHL-P-2.0](https://img.shields.io/badge/hardware-CERN--OHL--P--2.0-orange)](#)

An open-source, transparent **SBUS → RS-422** bridging solution for RC and embedded systems, comprising isolated hardware, a browser-based host tool, and a reproducible verification workflow.

This repository currently publishes the field-validated host software and the first hardware schematic PDF. Editable schematic sources, PCB, BOM, and fabrication files are still being prepared; the published material is suitable for understanding and reviewing the design, but should not be treated as a complete production-ready hardware package.

Hardware schematic: [`hardware/sbus-rs422-bridge-schematic.pdf`](hardware/sbus-rs422-bridge-schematic.pdf)

The host tool reads the module output through a USB-to-RS-422 serial port and displays reconstructed logic waveforms, raw SBUS packets, 16 channels, flag bits, frame rate, and anomaly statistics. It can also import generic three-channel CSV/TXT files that follow this project's exchange format to analyze input/output baud rates, per-frame consistency, and digital propagation delay — without depending on any specific logic analyzer brand.

```text
Standard inverted SBUS ──> optional inverter ──> isolated RS-422 bridge ──A/B──> USB→RS-422 ──> host tool
        │              currently enabled              │
        └── CH0 ─────── logic analyzer ────── CH1/CH2 ──┘  (only during test phases that explicitly allow a shared ground)
```

## System Architecture

```text
┌─────────────┐   inverted SBUS   ┌──────────────────────┐
│ SBUS source │ ────────────────▶ │ optional inverter     │
└─────────────┘                   └──────────┬───────────┘
                                             │ non-inverted logic
                                             ▼
                                    ┌──────────────────┐   differential A/B
                                    │ isolated RS-422  │ ───────────▶ USB→RS-422 ──▶ computer
                                    │ transceiver      │                           │
┌─────────────┐  CH0 input                            CH1/CH2 output      ▼
│ logic       │ ─────────────────────────────────────────────────────▶ browser host tool (this repo)
│ analyzer    │   shared time base / isolated separate captures (shared ground only allowed in test phases)
└─────────────┘
```

Host software layering:

```text
index.html ── styles.css ── src/app.js (Web Serial + live UI + import/export)
                         └── src/sbus.js        (frame codec / stream parser / stats / capture compare)
                         └── src/logic-capture.js (generic logic-capture CSV parsing / UART decode / frame align / delay)
                                 │
                             tests/*.test.js (node --test, 15 cases)
```

## Directory Structure

```text
sbus-rs422-bridge/
├── .github/workflows/ci.yml   # cross-platform automated tests
├── docs/
│   ├── dual-module-analysis.md         # general dual-UART module analysis tool guide
│   ├── 自研模块能力验证.md              # self-developed bridge capability verification report
│   └── protocol-compatibility.md       # SBUS variants and SBUS-like protocol pitfalls
├── hardware/                  # schematic PDF and hardware design goals (editable sources pending)
├── src/
│   ├── sbus.js                # headless SBUS core
│   ├── logic-capture.js       # generic logic-capture analysis
│   └── app.js                 # Web Serial host tool
├── tests/                     # protocol and logic-analysis automated tests
├── index.html / styles.css    # user interface
├── CONTRIBUTING.md
├── LICENSE                    # software MIT
└── README.md
```

## Hardware Features

- **SBUS → RS-422**: converts single-ended SBUS into the more noise-immune RS-422 complementary differential signal.
- **Optional logic inversion**: the board reserves selectable inverters on both the receive and transmit paths, allowing conversion between inverted SBUS and non-inverted UART logic.
- **Current configuration**: the external input uses standard inverted SBUS; the schematic's current assembly enables the inverter, converting it to non-inverted internal logic before feeding the isolated RS-422 transceiver.
- **Unchanged protocol content**: the inverter only changes logic polarity. The design goal remains to preserve `100000 bit/s / 8E2`, frame rate, and the 25-byte data content.
- **Electrical isolation**: the SBUS side and RS-422 side use separate grounds; the isolated transceiver blocks a direct ground connection between the two sides.
- **Mode and interface protection**: transceiver enable-mode selection, differential termination, and interface protection are provided. Current in-field tests and host-tool acceptance focus on the SBUS → RS-422 unidirectional link; reverse transmit and bidirectional modes are not yet claimed as verified features.

For specific components, polarity selection, and the mode table, see [`hardware/README.md`](hardware/README.md) and the [schematic PDF](hardware/sbus-rs422-bridge-schematic.pdf).

> [!CAUTION]
> This project has not been certified for aviation, automotive, or functional-safety use. Do not use it directly in a control link that could cause personal injury or property damage without independent failure analysis, environmental testing, and safety redundancy design.

## Project Status

- Host tool: usable; validated with a standard SBUS source, the bridge prototype, and a USB→RS-422 link.
- SBUS stream parsing and generic logic-capture sync/isolated analysis: 15 automated tests pass.
- Hardware open-source material: schematic PDF published; editable sources, PCB, BOM, and fabrication files still being prepared.
- Comparative validation: plan to introduce a commercial MCU-based SBUS→RS-422 module and compare stability, error rate, and propagation delay with this project's pure-hardware transparent bridge under identical conditions.
- Software license: MIT; hardware material in `hardware/` is licensed under CERN-OHL-P-2.0.

## Roadmap and TODO

- [ ] Complete same-condition comparison tests between the pure-hardware bridge and a commercial MCU conversion module.
- [ ] Publish raw captures, test environment, statistical definitions, and a reproducible report.
- [ ] Based on measured results, explain the value of pure-hardware transparent conversion in latency, determinism, and data transparency — without preset conclusions.

For the detailed test matrix, metric definitions, and dual-module analysis method, see [`docs/dual-module-analysis.md`](docs/dual-module-analysis.md).

## Acceptance Goals

This tool breaks "prove the module works and does not alter SBUS" into three verifiable levels:

1. **Functional availability**: after standard inverted SBUS passes through the currently enabled inverter and RS-422 bridge, the computer receives continuous 25-byte SBUS frames at `100000 baud / 8 data / even parity / 2 stop`, with header, footer, and 16 channels correctly parsed.
2. **Data unchanged**: after the input-side reference capture and the module output capture are automatically aligned by frame sequence, every complete 25-byte frame is byte-for-byte identical. The UI supports importing a reference JSON and reports the matched count and match rate.
3. **Electrical and timing unchanged**: RS-422 differential amplitude, common mode, rise/fall edges, termination, and precise bit width are verified by an oscilloscope or logic analyzer. The USB serial port only provides decoded bytes and cannot replace this measurement.

Therefore, with only the output-side USB-to-422 connection, this tool can prove "the module output is valid, parseable SBUS data"; to rigorously prove "data unchanged" you also need an input-side reference; to prove "physical waveform unchanged" you need external instrumentation.

## Protocol Compatibility: First Confirm Which "SBUS" It Is

This project strictly validates standard `100000 bit/s / 8E2 / inverted logic / 25 bytes / 16 channels` SBUS. A device spec saying "supports SBUS", "compatible with SBUS servos", or a port labeled "SBUS" does not necessarily mean the bytes currently on the wire are byte-compatible standard SBUS.

| Type | Current support | Caveats |
| --- | --- | --- |
| Standard SBUS / SBUS-16 | Full support | Must simultaneously satisfy baud rate, 8E2, polarity, frame length, and footer requirements |
| S.BUS2 | RC control frames only | Telemetry slots are not parsed; cannot prove full S.BUS2 bus transparent transport |
| W.BUS / W.BUS2 | Not accepted as standard SBUS | May drive servos or partial control data, but extended footers and extra bytes break strict byte-level equivalence |
| SBUS-24 | Not supported | 24-channel extension is not a standard 16-channel frame; all link devices must explicitly support it |
| Non-inverted, high-speed, or vendor-modified SBUS | Not supported by default | Similar frames do not imply electrical, baud-rate, or timing compatibility |
| F.Port, F.BUS, CRSF, etc. | Not supported | Different serial protocols; inverting or using an "SBUS" silkscreen pin will not turn them into SBUS |

Testing has indeed encountered W.BUS control data that looks like SBUS but cycles its footer in `0x01–0x0F` with extra bytes. Such a signal may be enough to drive compatible servos, yet cannot be used to prove byte-level transparent transport of standard SBUS. For the full compatibility matrix, S.BUS2 support boundary, and troubleshooting order, see [`docs/protocol-compatibility.md`](docs/protocol-compatibility.md).

## Running

Requires Chrome or Edge. Web Serial only works in a secure context; `localhost` is allowed, but double-clicking `index.html` usually will not work.

```bash
git clone https://github.com/Sailiono/sbus-rs422-bridge.git
cd sbus-rs422-bridge
npm start
```

Open in browser: <http://localhost:8765>

No third-party dependencies need to be installed. Without hardware, click "Run demo" to check all UI elements.

## Hardware Connection and Capture

```text
SBUS source ──> DUT SBUS→422 module ──A/B──> USB→422 ──> computer
                                            GND (connect per adapter instructions)
```

1. Confirm the 422 A/B definition. Different vendors may reverse A/B or `+/-` naming; check the manual first when unsure, and swap A/B if necessary.
2. Confirm bus termination. For long cables or high-speed edge tests, use about 120 Ω termination per the design; do not terminate at multiple positions.
3. Launch the page, click "Connect serial", and select the USB-to-422 device. The page always uses SBUS `100000 / 8E2`.
4. Capture at least several hundred frames continuously; observe valid frames, frame rate, sync anomalies, `FRAME LOST`, and `FAILSAFE`.
5. Export the JSON raw capture, CSV channel data, and HTML verification report.

### Software Verification Status

The current version covers standard SBUS continuous capture, 25-byte frame parsing, channel and flag decoding, input/output byte-for-byte comparison, and synchronized and isolated separate logic-capture analysis. The public repository is not bound to specific test equipment; different hardware combinations should submit capture files and acceptance records in the unified format below.

The UI separates "initial alignment bytes" from "runtime sync anomalies" and uses two consecutive frames to confirm the first lock, avoiding payload `0x0F` being mistaken for a frame header. A serial connection may start at an arbitrary in-frame byte; skipping some bytes before the first complete `0x0F + 25 bytes + valid footer` is a normal locking process; only bytes dropped after the first lock count as runtime anomalies.

Browser live capture uses a 64 KiB Web Serial receive buffer. The sync-anomaly count in the UI covers the entire chain — module, RS-422/USB adapter, driver, and browser reception — and alone cannot locate the fault source.

## Suggested Acceptance Method for "Data Unchanged"

### Method A: Fixed test sequence (easiest to land with existing hardware)

1. Make the SBUS source repeatedly output a known, deterministic channel sequence.
2. Capture the source with an input-side adapter that supports SBUS inversion and `100000 8E2`, and "export capture".
3. Connect the DUT and USB-to-422, and capture the module output.
4. In "byte-for-byte consistency", import the input-side JSON. The tool searches for the best offset within ±100 frames, then compares all alignable 25-byte frames.
5. A 100% match rate is required to conclude "byte-for-byte unchanged" for this capture.

## Generic Logic-Capture File Analysis

The host tool only defines a data exchange format and does not require a specific logic analyzer brand or companion software. Files with extension `.csv` or `.txt` are supported; UTF-8 encoding is recommended.

### Logic-Capture File Exchange Format

- Each line represents a sample point or a logic state-change event.
- The first column is time; the header uses `Time` or an equivalent, and may note `s`, `ms`, `us`/`µs`, or `ns`; seconds are assumed when unspecified.
- Channel columns use `CH0`, `CH1`, `CH2`, and equivalents like `Channel 0` are also accepted.
- Logic values may use `0/1`, `L/H`, `Low/High`, or `False/True`.
- Delimiters: comma, tab, semicolon, or consecutive whitespace.
- `CH0` is the inverted SBUS input, `CH1` is the RS-422 positive, `CH2` is the RS-422 negative.
- Time may be ascending or descending; the host tool normalizes it to relative time automatically.

Minimal example:

```csv
Time(s),CH0,CH1,CH2
0.000000,0,1,0
0.000010,1,0,1
0.000020,0,1,0
```

### Synchronized single CSV (recommended for test phases)

If the test phase explicitly allows the SBUS input ground and the 422 output ground to be shared, capture synchronously with one logic analyzer: CH0 to SBUS input, CH1 to 422+, CH2 to 422−. Export the raw digital sample file containing all three channels in the exchange format above, then click "Import synchronized CSV" in the host tool.

Synchronized mode preserves the common time axis of the three channels and directly reports:

- CH1/CH2 differential complement rate and correct output polarity;
- independently estimated input and output baud rates and their difference;
- input-to-output per-frame byte-for-byte consistency rate for complete 25-byte SBUS frames;
- propagation delay from input edge to output edge: median, P95, minimum, maximum, and sample count;
- three-channel digital waveform on a shared time axis.

### Isolated dual files

If the test goal is to verify module isolation, a shared-ground logic analyzer must not bridge both input and output sides, or the measurement system bypasses the isolation. Use two separate captures instead:

1. Make the SBUS source loop a fixed, repeatable test sequence.
2. Input-side capture: disconnect all output-side wires from the logic analyzer; connect the instrument GND only to the SBUS input ground, CH0 to the SBUS signal, and export CH0 CSV/TXT.
3. Output-side capture: fully remove the input-side GND and CH0; connect the instrument GND to the isolated 422 ground, CH1 to 422+, CH2 to 422−, and export CH1/CH2 CSV/TXT.
4. In the host tool's "isolated dual files" area, import the two sides in order; the tool auto-aligns by complete SBUS frame content.

Separate captures can prove data content and baud-rate consistency on both sides, but cannot measure propagation delay. To measure propagation delay while preserving isolation, you need two isolated acquisition devices sharing a time base, or rated-isolated differential/isolated probes. If the USB-to-422 GND is already tied to the module output ground, disconnect that GND/USB link or use a compliant USB isolator before the input-side capture.

## Waveform Meaning

The UI draws two logic lines:

- `USB-UART logic`: the ordinary UART logic corresponding to the bytes decoded by the USB-to-422 adapter.
- `Raw SBUS logic`: the inferred result of inverting the previous line according to SBUS inverted-level rules.

Each byte is reconstructed as `1 start + 8 data (LSB first) + even parity + 2 stop`, with each bit fixed at 10 μs. It explains frame content and bit order, but is not an oscilloscope measurement. Frame rate and jitter use USB data arrival times; when the adapter reports in batches, the UI notes "interval estimated".

## Files and Testing

- `src/sbus.js`: headless SBUS codec, stream parser, statistics, capture, and comparison core.
- `src/logic-capture.js`: generic logic-capture CSV/TXT parsing, UART decoding, frame alignment, and timing analysis.
- `src/app.js`: Web Serial capture, live UI, import/export.
- `docs/protocol-compatibility.md`: SBUS variants, SBUS-like protocols, and common compatibility pitfalls.
- `docs/dual-module-analysis.md`: general dual-UART module analysis tool guide.
- `docs/自研模块能力验证.md`: self-developed bridge capability verification report.
- `tests/`: protocol and logic-analysis automated tests.
- `hardware/`: hardware design goals and the location for future open-source material.
- `CONTRIBUTING.md`: contributions, test data, and safety notes.

Run tests:

```bash
npm test
```

Test coverage: frame codec round-trip, stream re-synchronization under noise and split chunks, S.BUS2 footer recognition, W.BUS extended-footer rejection, initial-alignment bytes not counted as runtime errors, two-frame lock against false positives, 8E2 waveform reconstruction, statistics and byte-for-byte comparison, capture JSON round-trip, generic CSV parsing (including descending-time normalization), and synchronized-single-file / isolated-dual-file UART decode / frame alignment / baud rate / propagation-delay analysis — 15 cases in total.

CI automatically runs the above tests on Ubuntu / Windows / macOS with Node 20 / 22.

## Suggested Formal Acceptance Record

- Prototype number, firmware/hardware version, cable length, termination resistor.
- USB-to-422 model and driver version.
- Capture duration, valid frame count, sync anomalies, Lost/Failsafe.
- Input/output JSON and 100% comparison result.
- Oscilloscope screenshots: input SBUS, A-B differential, bit width, frame period, rise/fall edges.
- Extreme conditions: minimum/maximum supply, cable length, temperature, and interference (select per product requirements).
