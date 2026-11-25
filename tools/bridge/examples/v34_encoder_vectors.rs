// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generates tools/tests/vectors/bm-v34-encoder.json: BinModem's V.34 data-mode
// encoder (from B1, §10.1.3.1) run on a fixed bit source, for every rate SynthLink
// configures and both scramblers. Points are in grid units. Regenerate with
//   cargo run --release --manifest-path tools/bridge/Cargo.toml --example v34_encoder_vectors > tools/tests/vectors/bm-v34-encoder.json
// and READ the diff: a changed vector is a change of reference, not a fix.
use datapump::v32::Mode;
use datapump::v34::data::{Encoder, Params};
use datapump::v34::frame::Framing;
use datapump::v34::info::SymbolRate;
use datapump::v34::trellis::Code;

const SYMBOLS: usize = 1200;

fn main() {
    // Every rate V34Mapper's ladder runs (RATE_CONFIGS): the receiver now picks
    // a rate from what it measured, so any of them can be the one on the wire.
    let mut cases: Vec<(u32, SymbolRate, String)> = Vec::new();
    for r in [14_400u32, 16_800, 19_200, 21_600] { cases.push((r, SymbolRate::S2400, format!("{r}/2400"))); }
    for r in [19_200u32, 21_600, 24_000, 26_400, 28_800, 31_200] { cases.push((r, SymbolRate::S3200, format!("{r}/3200"))); }
    for r in [19_200u32, 21_600, 24_000, 26_400, 28_800, 31_200, 33_600] { cases.push((r, SymbolRate::S3429, format!("{r}/3429"))); }
    let mut out = Vec::new();
    for (rate, sr, name) in &cases {
        let (rate, sr) = (*rate, *sr);
        for (mode, role) in [(Mode::Call, "call"), (Mode::Answer, "answer")] {
            let framing = Framing::new(sr, rate, false, false).unwrap();
            let mut e = Encoder::new(Params { framing, code: Code::States16, nonlinear: false, precoding: [(0, 0); 3], mode });
            let g = e.grid_scale();
            // xorshift32 from a fixed seed, low bit — the JS side reproduces it.
            let mut x: u32 = 0x2545_f491;
            let mut src = move || { x ^= x << 13; x ^= x >> 17; x ^= x << 5; x & 1 == 1 };
            let pts: Vec<String> = (0..SYMBOLS).map(|_| {
                let s = e.next_symbol(&mut src);
                format!("[{},{}]", (s.re * g).round() as i32, (s.im * g).round() as i32)
            }).collect();
            out.push(format!("  {{\"config\":\"{name}\",\"scrambler\":\"{role}\",\"points\":[{}]}}", pts.join(",")));
        }
    }
    println!("{{\n \"source\":\"BinModem datapump v34::data::Encoder, rev 623f935e28fe6de3a8a4f41492feb46e1bb86c3a\",\n \"seed\":\"0x2545f491\",\n \"cases\":[\n{}\n ]\n}}", out.join(",\n"));
}
