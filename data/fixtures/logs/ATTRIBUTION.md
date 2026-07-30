# Blackbox log fixtures — attribution

## `error-recovery.bbl`

A **real** Betaflight 4.2.11 blackbox binary log, vendored verbatim as a decode
test fixture (M14 / FR-LOG-01). It is **not** fabricated data.

- **Source:** the `blackbox-log` crate's own test corpus —
  <https://github.com/blackbox-log/blackbox-log/blob/main/tests/logs/error-recovery.bbl>
  (fetched from `https://raw.githubusercontent.com/blackbox-log/blackbox-log/main/tests/logs/error-recovery.bbl`).
- **License:** MIT OR Apache-2.0 (same as the `blackbox-log` crate;
  <https://github.com/blackbox-log/blackbox-log>).
- **Why this one:** it exercises the decoder's mid-log frame-recovery path and
  carries `time`, `rssi`, `vbatLatest`, `amperageLatest`, gyro/acc and motor
  channels (Betaflight 4.2.11, no GPS frame) — enough to verify the in-process
  decoder emits the exact columns/units `src/lib/blackbox.ts::parseBlackboxCsv`
  expects.

## `error-recovery.decoded.csv`

A **generated** golden file: the `blackbox_decode`-compatible CSV that the
in-process Rust decoder (`src-tauri/src/commands/logs.rs`) produces from
`error-recovery.bbl`. Regenerate it after any change to the decoder's CSV
formatting:

```
cd src-tauri && BLACKBOX_WRITE_GOLDEN=1 cargo test decodes_real_bbl_fixture_to_expected_csv
```

The TS golden round-trip test (`tests/unit/blackbox.test.ts`) feeds it back
through `parseBlackboxCsv` to prove the Rust-decode → TS-parse contract holds.
