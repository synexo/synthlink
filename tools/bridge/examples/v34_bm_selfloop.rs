// SPDX-License-Identifier: GPL-3.0-or-later
// Development aid: BinModem's V.34 data Encoder straight into its own Decoder at
// every ladder rate, no SynthLink involved — to tell a disagreement of ours from
// one BinModem has with itself.
use datapump::v32::Mode;
use datapump::v34::data::{Decoder, Encoder, Params};
use datapump::v34::frame::Framing;
use datapump::v34::info::SymbolRate;
use datapump::v34::trellis::Code;
fn main() {
    for (sr, name, rates) in [(SymbolRate::S3429, "3429", vec![19_200u32, 21_600, 24_000, 26_400, 28_800, 31_200, 33_600]),
                              (SymbolRate::S2400, "2400", vec![14_400, 16_800, 19_200, 21_600])] {
        for r in rates {
            let framing = Framing::new(sr, r, false, false).unwrap();
            let p = Params { framing, code: Code::States16, nonlinear: false, precoding: [(0, 0); 3], mode: Mode::Call };
            let (mut e, mut d) = (Encoder::new(p), Decoder::new(p));
            let mut x: u32 = 0x9e37_79b9; let mut sent = Vec::new();
            for _ in 0..4000 { let s = e.next_symbol(&mut || { x ^= x << 13; x ^= x >> 17; x ^= x << 5; let b = x & 1 == 1; sent.push(b); b }); d.feed(s); }
            let got = d.take_bits();
            let wrong = sent.iter().zip(&got).skip(23).filter(|(a, b)| a != b).count();
            println!("{r}/{name}: sent {} got {} wrong {}", sent.len(), got.len(), wrong);
        }
    }
}
