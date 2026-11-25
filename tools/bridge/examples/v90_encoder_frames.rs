// SPDX-License-Identifier: GPL-3.0-or-later
//
// BinModem's V.90 digital-modem encoder (§5.4, crates/datapump v90::encoder) on a
// fixed bit source, for each CP or CPt given on stdin as a line of 0s and 1s (the
// whole sequence, sync and CRC included, as SynthLink's analogue modem builds it).
// For tools/tests' V.90 encoder comparison: the same CP into V90Mapper's
// V90Coder must give the same codewords and signs.
//   node ... | cargo run --release --manifest-path tools/bridge/Cargo.toml --example v90_encoder_frames
use std::io::BufRead;

use datapump::v90::encoder::{Encoder, Mapping};
use datapump::v90::sequences::Cp;
use datapump::v90::ucode::Law;

const FRAMES: usize = 60;

fn main() {
    let mut out = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let line = line.trim();
        if line.is_empty() { continue; }
        let bits: Vec<bool> = line.bytes().map(|b| b == b'1').collect();
        let Some(cp) = Cp::from_bits(&bits) else { out.push("  {\"error\":\"CP did not parse\"}".to_string()); continue; };
        let Some(mapping) = Mapping::from_cp(&cp) else { out.push("  {\"error\":\"no mapping\"}".to_string()); continue; };
        let k = mapping.frame_bits();
        let mut e = Encoder::new(mapping, Law::Mu);
        // xorshift32 from a fixed seed, low bit — the JS side reproduces it.
        let mut x: u32 = 0x2545_f491;
        let mut src = move || { x ^= x << 13; x ^= x >> 17; x ^= x << 5; x & 1 == 1 };
        let frames: Vec<String> = (0..FRAMES).map(|_| {
            let f = e.next_frame(&mut src);
            let v: Vec<String> = (0..6).map(|i| {
                let u = f.ucodes[i] as i32;
                (if f.positive[i] { u } else { -u - 1000 }).to_string()
            }).collect();
            format!("[{}]", v.join(","))
        }).collect();
        out.push(format!("  {{\"drn\":{},\"sr\":\"{:?}\",\"ld\":{},\"frame_bits\":{},\"frames\":[{}]}}", cp.drn, cp.redundancy, cp.lookahead, k, frames.join(",")));
    }
    println!("[\n{}\n]", out.join(",\n"));
}
