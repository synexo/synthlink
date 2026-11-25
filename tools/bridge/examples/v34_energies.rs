// SPDX-License-Identifier: GPL-3.0-or-later
// Development aid: BinModem's data-mode mean energy per rate (grid_scale²), to
// compare with V34Mapper.meanEnergy. Not a vector; prints a table.
use datapump::v32::Mode;
use datapump::v34::data::{Encoder, Params};
use datapump::v34::frame::Framing;
use datapump::v34::info::SymbolRate;
use datapump::v34::trellis::Code;
fn main() {
    for (sr, name, rates) in [(SymbolRate::S3429, "3429", vec![19_200u32, 21_600, 24_000, 26_400, 28_800, 31_200, 33_600]),
                              (SymbolRate::S3200, "3200", vec![19_200, 21_600, 24_000, 26_400, 28_800, 31_200]),
                              (SymbolRate::S2400, "2400", vec![14_400, 16_800, 19_200, 21_600])] {
        for r in rates {
            let framing = Framing::new(sr, r, false, false).unwrap();
            let e = Encoder::new(Params { framing, code: Code::States16, nonlinear: false, precoding: [(0, 0); 3], mode: Mode::Call });
            let g = e.grid_scale();
            println!("{r}/{name} {:.2}", g * g);
        }
    }
}
