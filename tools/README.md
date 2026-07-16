# Benchmark Comparison Tool

`benchmark-compare.mjs` computes the metrics defined in
[`docs/dual-module-analysis.md`](../docs/dual-module-analysis.md)
for one or two devices under test (DUT), and emits a Markdown report. It reuses the
repository's own `src/sbus.js` and `src/logic-capture.js` so the numbers match
what the host tool reports.

## Inputs

| Mode | File | Notes |
| --- | --- | --- |
| `json` | host-tool capture export (`.json`, format `sbus-422-capture`) | No input-side reference, so transparency/delay are not computable from this file alone |
| `sync` | synchronized logic CSV (`Time,CH0,CH1,CH2`) | Full timing, propagation delay from shared time base |
| `isolated` | `"input.csv,output.csv"` (one slot, comma-separated) | Data/baud rate comparable; propagation delay not measurable |

The mode is auto-detected from the file extension (`.json` → `json`) and the
channel header (CH0 only → input, CH1+CH2 → output). Pass `--a-mode` /
`--b-mode` (`json`\|`sync`) to override.

## Usage

```bash
# Single DUT, host-tool capture
npm run benchmark -- --dut-a captures/dut-a-session.json --dut-a-name "DUT-A pure-hardware"

# Single DUT, synchronized logic CSV
npm run benchmark -- --dut-a captures/dut-a-sync.csv --dut-a-name "DUT-A sync"

# Single DUT, isolated dual-file capture
npm run benchmark -- --dut-a "captures/dut-a-in.csv,captures/dut-a-out.csv" --dut-a-name "DUT-A isolated"

# Two DUTs side-by-side
npm run benchmark -- \
  --dut-a "captures/dut-a-in.csv,captures/dut-a-out.csv" --dut-a-name "DUT-A pure-hardware" \
  --dut-b captures/dut-b-sync.csv --dut-b-name "DUT-B MCU module" \
  --meta "cable=1.5m,termination=120R,supply=5.0V" \
  > reports/benchmark-$(date +%Y%m%d).md

# Single multi-channel LA2016 capture: both modules on one synchronized time base.
# auto-detects the channel mapping, then decodes each module with its own params.
npm run benchmark -- \
  --dual "refs/接收机为FTR8B-...csv" \
  --a-baud 100000 --b-baud 115200 --b-parity none --b-stop 1 \
  --a-name "DUT-A pure-hardware bridge" --b-name "DUT-B commercial MCU"
```

### Dual-mode options (`--dual`)

`--dual <file>` parses a multi-channel LA2016 CSV, auto-detects the two output
pairs and the SBUS reference via `autoDetectMapping`, then runs
`analyzeDualModules`. Per-module signal parameters override the auto-estimate:

| Option | Default | Meaning |
| --- | --- | --- |
| `--a-baud` / `--b-baud` | (auto-estimated) | explicit bit rate for DUT-A / DUT-B |
| `--a-parity` / `--b-parity` | `even` | `even` \| `odd` \| `none` |
| `--a-stop` / `--b-stop` | `2` | stop bits (`1` or `2`) |

The report includes the detected channel mapping, per-module metrics, the
dual-module frame comparison (comparable / matched / match rate / delay), and a
side-by-side table. The commercial module's real 115200/8N1 output (which is
not a transparent SBUS byte stream) is reported faithfully, including 0 valid
frames.

## Metrics reported

Per DUT: valid frame count, frame/byte error rate, byte-for-byte data
transparency, frame rate, mean interval, arrival jitter σ, FRAME LOST /
FAILSAFE, input/output baud with Δ, RS-422 complement rate, and (sync only)
propagation delay (median / P95 / min / max with edge sample count). With two
DUTs a side-by-side table marks the lower error/jitter/delay or higher
transparency as "Better" — a raw indicator, not a verdict.

## Notes

- Archive raw captures and this report together; do not delete data unfavorable
  to either DUT.
- Keep one variable changed at a time for boundary-condition runs.
- See `docs/dual-module-analysis.md` for the full test matrix and
  statistical definitions.
