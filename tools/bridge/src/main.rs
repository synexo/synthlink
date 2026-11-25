// SPDX-License-Identifier: GPL-3.0-or-later
//
// bmpeer — one BinModem datapump as a lockstep audio peer, for SynthLink's
// development-only bridge harnesses (tools/tests/bm-*.js).
//
// Protocol on the pipe: the harness writes `--block` little-endian f32 samples
// to stdin, and bmpeer writes the same number back on stdout — the samples the
// modem put on the line while hearing them. Everything else is one JSON object
// per line on stderr:
//   {"ev":"phase","t":s,"phase":"...","status":"..."}   on every change
//   {"ev":"note","t":s,"text":"..."}                     BinModem's own notes
//   {"ev":"seq","t":s,"bits":"0x....","text":"..."}      V.32 rate sequences heard
//   {"ev":"jd","t":s,"jd":{...}}                         V.90: the Jd it read
//   {"ev":"connected","t":s,"status":"..."}              once, entering data
// --send TEXT is sent --send-delay seconds after that (default 0).
// --max-rate BPS caps what V.32 or V.32bis offers (default 9600 / 14400).
// --v32-trellis has V.32 offer trellis coding at 9600 (Table 6/V.32's B8).
// --v8 puts BinModem's V.8 in front of the v32, v32bis or v34 pump: a whole call.
//   {"ev":"rx","t":s,"hex":"..."}                        async bytes received
//
// --proto v22bis | v22 runs V.8 first (Phase 1), offering only the V.22/V.22bis
// bit, then V.22bis's own handshake at most at 2400 or 1200 bit/s.
// --proto bell103 runs Bell 103 alone (V.8 has no bit for it); --proto v21 runs
// V.8 offering only V.21, then V.21.
//   {"ev":"end","t":s,"phase":"...","status":"..."}      at EOF
//
// --v42 both|v44|v42bis (not none) also has its V.8 say LAPM (Table 6), as its
// modem does, and its stack take it as declared when ours said it too.
// --v42 both|v44|v42bis|none puts BinModem's own V.42 (crates/ec Stack) over
// the pump once it connects, as its modem does: the detection phase, XID, LAPM,
// and the compression named. --v42-late gives its answerer ten T400s for the
// far end's ODP instead of one (its waiting_for_a_late_far_end). --send then goes through it, and rx
// is what it delivers. {"ev":"note","text":"V.42: ..."} reports how it settled.
//
// --retrain-at S asks V.34 (11.5) or V.90's analogue modem (9.5.2.1) for a full
// retrain S seconds after it first
// connects, and --renegotiate-at S:BPS for a rate renegotiation (11.6) offering to
// receive at most BPS, each through its modem's own API (it begins neither by
// itself). --send-again S:TEXT sends a second text S seconds after connecting,
// once it is connected again; \r and \n in TEXT are CR and LF.
//
// --echo G --echo-delay N add this end's own hybrid return (2-wire); the
// harness adds SynthLink's on its side.
//
// For v90 the pipe carries the DIGITAL modem's side of the network: levels at
// 8 kHz on G.711's scale over 32768, which is what SynthLink's V.90 digital modem
// emits and expects. BinModem's own network model sits between them and its
// analogue modem, which runs at 16 kHz as it does on a real call.

use std::io::{Read, Write};

use datapump::framing::AsyncBits;
use datapump::v32::startup as v32s;
use datapump::v34::{phase2, startup as v34s};
use datapump::v90::{network::Network, startup as v90s, ucode::Law};
use datapump::v8 as v8l;
use datapump::v22bis::{Rate, handshake as v22h};
use datapump::{bell103 as b103, v21};
use ec::{Compression, Role as EcRole, Stack};

/// The first number in a status string: the line rate, for T401.
fn rate_of(status: &str) -> u32 {
    let digits: String = status.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(2400)
}

/// The sample rate the V.22 family runs at here, which is the pipe's.
const FS_V22: f64 = 8000.0;

enum Peer {
    /// V.8 (Phase 1), then V.22bis's own handshake on what V.8 chose.
    V22 { v8: Box<v8l::Modem>, pump: Option<Box<v22h::Modem>>, role: v22h::Role, ceiling: Rate, log: Vec<String> },
    /// 300 bit/s FSK: Bell 103 on its own (it has no V.8 bit), or V.8 then V.21.
    Fsk { v8: Option<Box<v8l::Modem>>, pump: Option<Box<b103::Modem>>, role: b103::Role, v21: bool, log: Vec<String> },
    V32(Box<v32s::Modem>),
    V34(Box<v34s::Modem>),
    V90 { modem: Box<v90s::Analogue>, net: Box<Network>, up: Vec<f64> },
    /// BinModem's V.90 DIGITAL modem, its codewords handed to the far end as a SIP
    /// gateway hands them, exactly: G.711 at the law, then a T1's robbed bit and a
    /// digital pad as datapump::v90::network carries them, and no codec waveform.
    V90D { modem: Box<v90s::Digital>, law: Law, rbs: Option<usize>, pad: f64, octets: usize },
    /// V.8 (Phase 1) in front of a pump built without it — V.32/V.32bis or V.34 —
    /// as BinModem's own modem does (crates/modem `start_pump_with`): the pump is
    /// handed the line once V.8 agrees, or once it finds the far end has no V.8.
    V8 { v8: Box<v8l::Modem>, inner: Option<Box<Peer>>, pending: Option<Box<Peer>>, log: Vec<String> },
}

impl Peer {
    fn step(&mut self, x: f64) -> f64 {
        match self {
            Peer::Fsk { v8, pump, role, v21, log } => {
                if let Some(p) = pump {
                    return p.step(x);
                }
                let y = v8.as_mut().map_or(0.0, |v| v.step(x));
                let st = v8.as_ref().map(|v| v.status());
                let go = match st {
                    None => true,
                    Some(v8l::Status::Agreed(m)) => { log.push(format!("V.8 agreed {m:?}")); true }
                    Some(v8l::Status::NoNegotiation) => { log.push("V.8: no negotiation".into()); true }
                    _ => false,
                };
                if go {
                    let plan = if *v21 { b103::Modem::with_plan(v21::DATA, *role, FS_V22) } else { b103::Modem::new(*role, FS_V22) };
                    *pump = Some(Box::new(plan));
                }
                y
            }
            Peer::V22 { v8, pump, role, ceiling, log } => {
                if let Some(p) = pump {
                    return p.step(x);
                }
                let y = v8.step(x);
                match v8.status() {
                    v8l::Status::Agreed(m) => {
                        log.push(format!("V.8 agreed {m:?}"));
                        *pump = Some(Box::new(v22h::Modem::at_most(*role, *ceiling, FS_V22)));
                    }
                    v8l::Status::NoNegotiation => {
                        log.push("V.8: no negotiation".into());
                        *pump = Some(Box::new(v22h::Modem::at_most(*role, *ceiling, FS_V22)));
                    }
                    _ => {}
                }
                y
            }
            Peer::V32(m) => m.step(x),
            Peer::V34(m) => m.step(x),
            Peer::V8 { v8, inner, pending, log } => {
                if let Some(p) = inner {
                    return p.step(x);
                }
                let y = v8.step(x);
                let go = match v8.status() {
                    v8l::Status::Agreed(m) => { log.push(format!("V.8 agreed {m:?}")); true }
                    v8l::Status::NoNegotiation => { log.push("V.8: no negotiation".into()); true }
                    _ => false,
                };
                if go { *inner = pending.take(); }
                y
            }
            Peer::V90D { modem, law, rbs, pad, octets } => {
                use datapump::v90::ucode;
                let q = |law: Law, v: f64| {
                    let (u, neg) = ucode::nearest(law, (v * 32768.0).round() as i32);
                    ucode::level(law, u) * if neg { -1.0 } else { 1.0 }
                };
                // The analogue modem's waveform through the codec's sampler, and the
                // level the digital modem sends back through the route.
                let y = modem.step(q(*law, x));
                let (u, neg) = ucode::nearest(*law, (y * 32768.0).round() as i32);
                let mut o = ucode::octet(*law, u, neg);
                if *rbs == Some(*octets % 6) { o |= 1; }
                *octets += 1;
                let (u, neg) = ucode::from_octet(*law, o);
                let level = ucode::level(*law, u) * if neg { -1.0 } else { 1.0 };
                if *pad == 1.0 { level } else { q(*law, level * *pad) }
            }
            Peer::V90 { modem, net, up } => {
                // One network sample: the codeword the digital modem sent goes
                // down, and the level the analogue modem's upstream makes of
                // this instant comes back.
                let to_digital = net.up(up);
                up.clear();
                for s in net.down(x) {
                    up.push(modem.step(s));
                }
                to_digital
            }
        }
    }

    fn phase(&self) -> String {
        match self {
            Peer::V22 { v8, pump, .. } => match pump { Some(p) => format!("V.22bis {}", p.phase()), None => format!("V.8 {}", v8.phase()) },
            Peer::Fsk { v8, pump, .. } => match (pump, v8) {
                (Some(p), _) => format!("{} {}", p.standard(), p.line_phase()),
                (None, Some(v)) => format!("V.8 {}", v.phase()),
                _ => "starting".into(),
            },
            Peer::V32(m) => m.phase().to_string(),
            Peer::V34(m) => m.phase().to_string(),
            Peer::V90 { modem, .. } => modem.phase().to_string(),
            Peer::V90D { modem, .. } => modem.phase().to_string(),
            Peer::V8 { inner: Some(p), .. } => p.phase(),
            Peer::V8 { v8, .. } => format!("V.8 {}", v8.phase()),
        }
    }

    fn status(&self) -> String {
        match self {
            Peer::V22 { v8, pump, .. } => match pump { Some(p) => format!("{:?}", p.status()), None => format!("{:?}", v8.status()) },
            Peer::Fsk { v8, pump, .. } => match (pump, v8) {
                (Some(p), _) => format!("{:?}", p.status()),
                (None, Some(v)) => format!("{:?}", v.status()),
                _ => String::new(),
            },
            Peer::V32(m) => format!("{:?} coding={:?}", m.status(), m.coding()),
            Peer::V34(m) => format!("{:?}", m.status()),
            Peer::V90 { modem, .. } => format!("{:?}", modem.status()),
            Peer::V90D { modem, .. } => format!("{:?}", modem.status()),
            Peer::V8 { inner: Some(p), .. } => p.status(),
            Peer::V8 { v8, .. } => format!("{:?}", v8.status()),
        }
    }

    fn connected(&self) -> bool {
        match self {
            Peer::V22 { pump, .. } => pump.as_ref().is_some_and(|p| matches!(p.status(), v22h::Status::Connected(_))),
            Peer::Fsk { pump, .. } => pump.as_ref().is_some_and(|p| matches!(p.status(), b103::Status::Connected(_))),
            Peer::V32(m) => matches!(m.status(), v32s::Status::Connected(_)),
            Peer::V34(m) => matches!(m.status(), v34s::Status::Connected { .. }),
            Peer::V90 { modem, .. } => matches!(modem.status(), v90s::Status::Connected { .. }),
            Peer::V90D { modem, .. } => matches!(modem.status(), v90s::Status::Connected { .. }),
            Peer::V8 { inner, .. } => inner.as_ref().is_some_and(|p| p.connected()),
        }
    }

    fn send_bits(&mut self, bits: &[bool]) {
        match self {
            Peer::V22 { pump, .. } => { if let Some(p) = pump { p.send_bits(bits) } }
            Peer::Fsk { pump, .. } => { if let Some(p) = pump { p.send_bits(bits) } }
            Peer::V32(m) => m.send_bits(bits),
            Peer::V34(m) => m.send_bits(bits),
            Peer::V90 { modem, .. } => modem.send_bits(bits),
            Peer::V90D { modem, .. } => modem.send_bits(bits),
            Peer::V8 { inner, .. } => { if let Some(p) = inner { p.send_bits(bits) } }
        }
    }

    fn pending_bits(&self) -> usize {
        match self {
            Peer::V22 { pump, .. } => pump.as_ref().map_or(0, |p| p.pending_bits()),
            Peer::Fsk { pump, .. } => pump.as_ref().map_or(0, |p| p.pending_bits()),
            Peer::V32(m) => m.pending_bits(),
            Peer::V34(m) => m.pending_bits(),
            Peer::V90 { modem, .. } => modem.pending_bits(),
            Peer::V90D { modem, .. } => modem.pending_bits(),
            Peer::V8 { inner, .. } => inner.as_ref().map_or(0, |p| p.pending_bits()),
        }
    }

    fn accepts_bits(&self) -> bool {
        match self {
            Peer::V34(m) => m.accepts_bits(),
            Peer::V90 { modem, .. } => modem.accepts_bits(),
            Peer::V90D { modem, .. } => modem.accepts_bits(),
            Peer::V8 { inner, .. } => inner.as_ref().is_some_and(|p| p.accepts_bits()),
            _ => true,
        }
    }

    fn take_bits(&mut self) -> Vec<bool> {
        match self {
            Peer::V22 { pump, .. } => pump.as_mut().map_or_else(Vec::new, |p| p.take_bits()),
            Peer::Fsk { pump, .. } => pump.as_mut().map_or_else(Vec::new, |p| p.take_bits()),
            Peer::V32(m) => m.take_bits(),
            Peer::V34(m) => m.take_bits(),
            Peer::V90 { modem, .. } => modem.take_bits(),
            Peer::V90D { modem, .. } => modem.take_bits(),
            Peer::V8 { inner, .. } => inner.as_mut().map_or_else(Vec::new, |p| p.take_bits()),
        }
    }

    fn take_notes(&mut self) -> Vec<String> {
        match self {
            Peer::V22 { log, .. } => std::mem::take(log),
            Peer::Fsk { log, .. } => std::mem::take(log),
            Peer::V90 { modem, .. } => modem.take_notes(),
            Peer::V90D { modem, .. } => modem.take_notes(),
            Peer::V8 { inner, log, .. } => {
                let mut v = std::mem::take(log);
                if let Some(p) = inner { v.extend(p.take_notes()); }
                v
            }
            _ => Vec::new(),
        }
    }

    /// V.90's Jd as the analogue modem read it (8.4.2, Table 13), once it has.
    fn far_jd(&self) -> Option<String> {
        match self {
            Peer::V90 { modem, .. } => modem.v90().and_then(|m| m.far_jd()).map(|jd| {
                format!(
                    "{{\"rates\":{},\"sixteen_in_training\":{},\"sixteen_in_renegotiation\":{},\"lookahead\":{}}}",
                    jd.rates, jd.sixteen_in_training, jd.sixteen_in_renegotiation, jd.lookahead
                )
            }),
            _ => None,
        }
    }

    /// What BinModem's V.32 receiver says about how it is doing, as JSON: for
    /// telling a far end it cannot slice from one it never trained on.
    fn diag(&self) -> Option<String> {
        match self {
            Peer::V8 { inner, .. } => inner.as_ref().and_then(|p| p.diag()),
            Peer::V32(m) => {
                let r = m.receiver();
                Some(format!(
                    "{{\"stage\":\"{:?}\",\"snr_db\":{:.1},\"trained_snr_db\":{:.1},\"via\":\"{:?}\",\"offset_hz\":{:.2},\"drift_ppm\":{:.1},\"gain_db\":{:.1},\"rot\":{:.1},\"slips\":{},\"lost\":{},\"err\":{:.4}}}",
                    r.stage(), r.snr_db(), r.trained_snr_db(), r.trained_via(), r.offset_hz(), r.drift_ppm(), r.gain_db(),
                    r.rotation_degrees(), r.slips(), r.is_lost(), r.residual_error()
                ))
            }
            Peer::V34(m) => m.training().map(|t| format!(
                "{{\"b1_errors\":{},\"path_cost\":{},\"found_again\":{},\"snr\":{:.1},\"phase4_snr\":{},\"slips\":{},\"rates\":\"{:?}\"}}",
                t.b1_errors(), t.path_cost().map_or("null".into(), |c| format!("{c:.2}")), t.found_again(), t.snr(),
                t.phase4_snr().map_or("null".into(), |c| format!("{c:.1}")), t.slips(), t.rates())),
            _ => None,
        }
    }

    /// Whether V.8 settled LAPM: both ends' CM/JM said it (Table 6, 7.4).
    fn v8_lapm(&self) -> bool {
        match self {
            Peer::V8 { v8, .. } => v8.lapm(),
            Peer::V22 { v8, .. } => v8.lapm(),
            _ => false,
        }
    }

    /// A full retrain from data mode (11.5/V.34), as its modem's API begins one.
    fn retrain(&mut self) -> bool {
        match self {
            Peer::V34(m) => m.retrain(),
            Peer::V90 { modem, .. } => modem.retrain(),
            Peer::V90D { modem, .. } => modem.retrain(),
            Peer::V8 { inner: Some(p), .. } => p.retrain(),
            _ => false,
        }
    }

    /// A rate renegotiation from data mode (11.6/V.34, 9.6.2.1/V.90), offering to
    /// receive at most `bps`: V.34 in steps of 2400, V.90's analogue modem at the
    /// fastest downstream its route carries within it.
    fn renegotiate(&mut self, bps: u32) -> bool {
        let receive = (bps / 2400).clamp(1, 14) as u8;
        match self {
            Peer::V34(m) => m.renegotiate(receive),
            Peer::V90 { modem, .. } => modem.renegotiate(bps),
            Peer::V90D { modem, .. } => modem.renegotiate(receive),
            Peer::V8 { inner: Some(p), .. } => p.renegotiate(bps),
            _ => false,
        }
    }

    /// V.32's 16-bit start-up sequences as the receiver decoded them (5.3).
    fn take_sequences(&mut self) -> Vec<u16> {
        match self {
            Peer::V8 { inner, .. } => inner.as_mut().map_or_else(Vec::new, |p| p.take_sequences()),
            Peer::V32(m) => m.take_sequences(),
            _ => Vec::new(),
        }
    }
}

struct Opts {
    proto: String,
    role: String,
    fs: f64,
    block: usize,
    send: Option<String>,
    up_gain: f64,
    /// V.90's network (datapump::v90::network): a T1's robbed bit at this
    /// interval, a digital pad in dB, and A-law in place of mu-law.
    rbs: Option<usize>,
    pad: Option<f64>,
    alaw: bool,
    delay: f64,
    noise: f64,
    echo: f64,
    echo_delay: usize,
    send_delay: f64,
    max_rate: u32,
    v32_trellis: bool,
    v8: bool,
    v42: Option<String>,
    v42_late: bool,
    retrain_at: Option<f64>,
    renegotiate_at: Option<(f64, u32)>,
    send_again: Option<(f64, String)>,
}

fn parse() -> Result<Opts, String> {
    let mut o = Opts {
        proto: String::new(),
        role: String::new(),
        fs: 8000.0,
        block: 160,
        send: None,
        up_gain: 0.25,
        rbs: None,
        pad: None,
        alaw: false,
        delay: 0.010,
        noise: 1e-5,
        echo: 0.0,
        echo_delay: 0,
        send_delay: 0.0,
        max_rate: 0,
        v32_trellis: false,
        v8: false,
        v42: None,
        v42_late: false,
        retrain_at: None,
        renegotiate_at: None,
        send_again: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut v = || args.next().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--proto" => o.proto = v()?.to_ascii_lowercase(),
            "--role" => o.role = v()?.to_ascii_lowercase(),
            "--fs" => o.fs = v()?.parse().map_err(|_| "bad --fs")?,
            "--block" => o.block = v()?.parse().map_err(|_| "bad --block")?,
            "--send" => o.send = Some(v()?),
            "--up-gain" => o.up_gain = v()?.parse().map_err(|_| "bad --up-gain")?,
            "--rbs" => o.rbs = Some(v()?.parse().map_err(|_| "bad --rbs")?),
            "--pad" => o.pad = Some(v()?.parse().map_err(|_| "bad --pad")?),
            "--alaw" => o.alaw = true,
            "--delay" => o.delay = v()?.parse().map_err(|_| "bad --delay")?,
            "--noise" => o.noise = v()?.parse().map_err(|_| "bad --noise")?,
            "--echo" => o.echo = v()?.parse().map_err(|_| "bad --echo")?,
            "--echo-delay" => o.echo_delay = v()?.parse().map_err(|_| "bad --echo-delay")?,
            "--v32-trellis" => o.v32_trellis = true,
            "--v8" => o.v8 = true,
            "--v42" => o.v42 = Some(v()?.to_ascii_lowercase()),
            "--v42-late" => o.v42_late = true,
            "--retrain-at" => o.retrain_at = Some(v()?.parse().map_err(|_| "bad --retrain-at")?),
            "--renegotiate-at" => {
                let a = v()?;
                let (t, r) = a.split_once(':').ok_or("--renegotiate-at SECONDS:BPS")?;
                let bps: u32 = r.parse().map_err(|_| "bad --renegotiate-at rate")?;
                o.renegotiate_at = Some((t.parse().map_err(|_| "bad --renegotiate-at time")?, bps));
            }
            "--send-again" => {
                let a = v()?;
                let (t, text) = a.split_once(':').ok_or("--send-again SECONDS:TEXT")?;
                o.send_again = Some((t.parse().map_err(|_| "bad --send-again time")?, text.replace("\\r", "\r").replace("\\n", "\n")));
            }
            "--max-rate" => o.max_rate = v()?.parse().map_err(|_| "bad --max-rate")?,
            "--send-delay" => o.send_delay = v()?.parse().map_err(|_| "bad --send-delay")?,

            _ => return Err(format!("unknown argument {a}")),
        }
    }
    if !matches!(o.role.as_str(), "call" | "answer") {
        return Err("--role must be call or answer".into());
    }
    Ok(o)
}

fn build(o: &Opts) -> Result<Peer, String> {
    let pump = build_pump(o)?;
    if !o.v8 {
        return Ok(pump);
    }
    // One V.8 modulation, as SynthLink's single-protocol dial offers: the V.32 bit
    // serves V.32 and V.32bis both, and V.34 is V.34 full duplex.
    let modulation = match o.proto.as_str() {
        "v32" | "v32bis" => v8::Modulation::V32bis,
        "v34" => v8::Modulation::V34Duplex,
        p => return Err(format!("--v8: {p} already runs its own V.8, or has none")),
    };
    let v8role = if o.role == "call" { v8l::Role::Calling } else { v8l::Role::Answering };
    let mut v8 = v8l::Modem::new(v8role, v8::CallFunction::Data, v8::Modulations::of(&[modulation]), o.fs);
    // As BinModem's modem does with error control wanted: LAPM in its CM/JM.
    if o.v42.as_deref().is_some_and(|m| m != "none") { v8 = v8.offering_lapm(); }
    Ok(Peer::V8 { v8: Box::new(v8), inner: None, pending: Some(Box::new(pump)), log: Vec::new() })
}

fn build_pump(o: &Opts) -> Result<Peer, String> {
    let call = o.role == "call";
    Ok(match o.proto.as_str() {
        "bell103" | "v21" => {
            if o.fs != FS_V22 { return Err(format!("{}: --fs must be {FS_V22}", o.proto)); }
            let role = if call { b103::Role::Originate } else { b103::Role::Answer };
            let v21 = o.proto == "v21";
            let v8 = v21.then(|| {
                let v8role = if call { v8l::Role::Calling } else { v8l::Role::Answering };
                Box::new(v8l::Modem::new(v8role, v8::CallFunction::Data, v8::Modulations::of(&[v8::Modulation::V21]), o.fs))
            });
            Peer::Fsk { v8, pump: None, role, v21, log: Vec::new() }
        }
        "v22bis" | "v22" => {
            // A modem offering exactly one V.8 modulation — the V.22/V.22bis bit,
            // which serves both — and at most 1200 or 2400 bit/s, as SynthLink's
            // single-protocol dial does.
            let v8role = if call { v8l::Role::Calling } else { v8l::Role::Answering };
            let ours = v8::Modulations::of(&[v8::Modulation::V22bis]);
            let mut v8 = v8l::Modem::new(v8role, v8::CallFunction::Data, ours, o.fs);
            if o.v42.as_deref().is_some_and(|m| m != "none") { v8 = v8.offering_lapm(); }
            let role = if call { v22h::Role::Calling } else { v22h::Role::Answering };
            let ceiling = if o.proto == "v22" { Rate::Bps1200 } else { Rate::Bps2400 };
            if o.fs != FS_V22 { return Err(format!("{}: --fs must be {FS_V22}", o.proto)); }
            Peer::V22 { v8: Box::new(v8), pump: None, role, ceiling, log: Vec::new() }
        }
        "v32" | "v32bis" => {
            let offer = if o.proto == "v32" {
                v32s::rate_signal_v32(v32s::Rates::between(4800, if o.max_rate > 0 { o.max_rate } else { 9600 }), o.v32_trellis)
            } else {
                v32s::rate_signal(v32s::Rates::between(4800, if o.max_rate > 0 { o.max_rate } else { 14400 }))
            };
            let role = if call { v32s::Role::Calling } else { v32s::Role::Answering };
            Peer::V32(Box::new(v32s::Modem::new(role, offer, o.fs)))
        }
        "v34" => {
            let role = if call { phase2::Role::Call } else { phase2::Role::Answer };
            Peer::V34(Box::new(v34s::Modem::new(role, o.fs)))
        }
        "v90" if !call => {
            // BinModem plays the DIGITAL modem, the answerer: a server's INFO0d.
            let mut info0d = datapump::v90::server::ours();
            info0d.a_law = o.alaw;
            let law = if o.alaw { Law::A } else { Law::Mu };
            Peer::V90D { modem: Box::new(v90s::Digital::new(info0d, 0.0)), law, rbs: o.rbs, pad: o.pad.map_or(1.0, |db| 10f64.powf(-db / 20.0)), octets: 0 }
        }
        "v90" => {
            // BinModem plays the ANALOGUE modem, which is the caller.
            let fs = 16_000.0;
            let mut net = Network::new(if o.alaw { Law::A } else { Law::Mu }, fs)
                .with_delay(o.delay, fs)
                .with_noise(o.noise)
                .with_upstream_gain(o.up_gain);
            if let Some(p) = o.rbs { net = net.with_robbed_bit(p); }
            if let Some(db) = o.pad { net = net.with_pad(db); }
            Peer::V90 { modem: Box::new(v90s::Analogue::new(fs, 0.0)), net: Box::new(net), up: Vec::new() }
        }
        p => return Err(format!("unknown --proto {p}")),
    })
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

fn main() {
    let mut o = match parse() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{{\"ev\":\"error\",\"text\":\"{}\"}}", esc(&e));
            std::process::exit(2);
        }
    };
    let mut peer = match build(&o) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{{\"ev\":\"error\",\"text\":\"{}\"}}", esc(&e));
            std::process::exit(2);
        }
    };
    // The pipe runs at the network's rate for v90 and at --fs otherwise.
    let rate = if o.proto == "v90" { 8000.0 } else { o.fs };
    let framing = AsyncBits::new(8);
    let mut deframe = AsyncBits::new(8);
    let (mut inp, mut out, mut err) = (std::io::stdin().lock(), std::io::stdout().lock(), std::io::stderr().lock());
    let mut buf = vec![0u8; 4 * o.block];
    let mut obuf = Vec::with_capacity(4 * o.block);
    let mut n: u64 = 0;
    let mut last = String::new();
    let mut connected_at: Option<u64> = None;
    let mut jd_seen = false;
    let mut payload_sent = false;
    let t = |n: u64| n as f64 / rate;
    // This end's own hybrid, for a 2-wire line: what it sends comes back into
    // what it hears, `echo_delay` samples later. Done here rather than by the
    // harness so the return is sample-exact rather than a block late.
    let mut own: std::collections::VecDeque<f64> = std::iter::repeat_n(0.0, o.echo_delay.max(1)).collect();
    let mut sent = 0.0f64;
    // BinModem's own V.42 over the pump, once it connects (--v42).
    let mut stack: Option<Stack> = None;
    let mut ec_settled = false;
    let mut ec_ms = 0.0f64;
    // What the pump takes between two refills, and some: this loop refills once a
    // block, so 64 bits (BinModem's own per-bit refill) would run it dry at any
    // rate past 3200 bit/s and put its idle pattern inside a frame.
    let mut ec_fill = 64usize;
    loop {
        if inp.read_exact(&mut buf).is_err() {
            break;
        }
        obuf.clear();
        for c in buf.chunks_exact(4) {
            let mut x = f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64;
            if o.echo != 0.0 {
                own.push_back(sent);
                x += o.echo * own.pop_front().unwrap_or(0.0);
            }
            sent = peer.step(x);
            obuf.extend_from_slice(&(sent as f32).to_le_bytes());
            n += 1;
        }
        if out.write_all(&obuf).and_then(|_| out.flush()).is_err() {
            break;
        }
        let (phase, status) = (peer.phase(), peer.status());
        let key = format!("{phase}|{status}");
        if key != last {
            let _ = writeln!(err, "{{\"ev\":\"phase\",\"t\":{:.4},\"phase\":\"{}\",\"status\":\"{}\"}}", t(n), esc(&phase), esc(&status));
            last = key;
        }
        for note in peer.take_notes() {
            let _ = writeln!(err, "{{\"ev\":\"note\",\"t\":{:.4},\"text\":\"{}\"}}", t(n), esc(&note));
        }
        if !jd_seen && let Some(jd) = peer.far_jd() {
            jd_seen = true;
            let _ = writeln!(err, "{{\"ev\":\"jd\",\"t\":{:.4},\"jd\":{jd}}}", t(n));
        }
        if n % 2000 < o.block as u64 && let Some(d) = peer.diag() {
            let _ = writeln!(err, "{{\"ev\":\"diag\",\"t\":{:.4},\"diag\":{d}}}", t(n));
        }
        for seq in peer.take_sequences() {
            let _ = writeln!(err, "{{\"ev\":\"seq\",\"t\":{:.4},\"bits\":\"0x{seq:04x}\",\"text\":\"{}\"}}", t(n), esc(&v32s::describe_sequence(seq)));
        }
        if connected_at.is_none() && peer.connected() {
            connected_at = Some(n);
            let _ = writeln!(err, "{{\"ev\":\"connected\",\"t\":{:.4},\"status\":\"{}\"}}", t(n), esc(&status));
            if let Some(mode) = o.v42.as_ref() {
                let role = if o.role == "call" { EcRole::Originator } else { EcRole::Answerer };
                let params = ec::lapm::Params { t401_ms: ec::lapm::t401_for(rate_of(&status)), ..ec::lapm::Params::default() };
                let mut s = Stack::new(role, params);
                if o.v42_late {
                    s = s.waiting_for_a_late_far_end();
                }
                if peer.v8_lapm() {
                    s = s.declared_lapm();
                    let _ = writeln!(err, "{{\"ev\":\"note\",\"t\":{:.4},\"text\":\"V.8: both said LAPM\"}}", t(n));
                }
                if mode != "none" {
                    s.offer_compression(Compression::Both);
                    if mode == "v44" { s.without_v42bis(); }
                    if mode == "v42bis" { s.without_v44(); }
                }
                stack = Some(s);
                ec_fill = 64 + (rate_of(&status) as f64 * o.block as f64 / rate).ceil() as usize;
            }
        }
        if let Some(s) = stack.as_mut() {
            ec_ms += o.block as f64 * 1000.0 / rate;
            let whole = ec_ms.floor();
            ec_ms -= whole;
            s.tick(whole as u32);
            if !ec_settled && s.settled() {
                ec_settled = true;
                let how = if s.is_connected() { format!("LAPM compression={}", s.compression_name().unwrap_or("none")) } else { format!("none ({:?})", s.phase()) };
                let _ = writeln!(err, "{{\"ev\":\"note\",\"t\":{:.4},\"text\":\"V.42: {}\"}}", t(n), esc(&how));
            }
        }
        // --retrain-at / --renegotiate-at: seconds after connecting, as a modem's
        // own API would be asked to.
        if let Some(c) = connected_at {
            let since = (n - c) as f64 / rate;
            if let Some(at) = o.retrain_at && since >= at {
                o.retrain_at = None;
                let ok = peer.retrain();
                let _ = writeln!(err, "{{\"ev\":\"note\",\"t\":{:.4},\"text\":\"retrain asked: {ok}\"}}", t(n));
            }
            if let Some((at, r)) = o.renegotiate_at && since >= at {
                o.renegotiate_at = None;
                let ok = peer.renegotiate(r);
                let _ = writeln!(err, "{{\"ev\":\"note\",\"t\":{:.4},\"text\":\"renegotiation asked ({}): {ok}\"}}", t(n), r);
            }
            if let Some((at, text)) = o.send_again.clone() && since >= at && peer.connected() {
                o.send_again = None;
                if let Some(s) = stack.as_mut().filter(|s| s.is_connected()) {
                    s.send(text.as_bytes());
                } else {
                    let mut bits = vec![true; 64];
                    for &b in text.as_bytes() { bits.extend(framing.encode(b)); }
                    bits.extend(std::iter::repeat_n(true, 64));
                    peer.send_bits(&bits);
                }
            }
        }
        let ec_ready = stack.as_ref().is_none_or(|s| s.settled());
        if !payload_sent && ec_ready && connected_at.is_some_and(|c| (n - c) as f64 / rate >= o.send_delay) {
            payload_sent = true;
            if let (Some(text), Some(s)) = (o.send.as_ref(), stack.as_mut().filter(|s| s.is_connected())) {
                s.send(text.as_bytes());
            } else if let Some(text) = o.send.as_ref() {
                // Marks first so the far UART is idle before the first start bit.
                let mut bits = vec![true; 64];
                for &b in text.as_bytes() {
                    bits.extend(framing.encode(b));
                }
                bits.extend(std::iter::repeat_n(true, 64));
                peer.send_bits(&bits);
            }
        }
        // Drained every block, kept only once connected: a pump demodulates its
        // training too, and draining it first at connect handed the harness a
        // burst of that as "received data" (850 bytes of it at V.22bis 2400).
        let drained = peer.take_bits();
        if let Some(s) = stack.as_mut().filter(|s| !matches!(s.phase(), ec::stack::Phase::Transparent)) {
            for b in drained {
                s.feed_bit(b);
            }
            // Kept fed, as BinModem's modem does: a pump run dry puts its idle
            // pattern in the middle of a frame, which reads as an abort.
            while peer.accepts_bits() && peer.pending_bits() < ec_fill {
                let b = s.next_bit();
                peer.send_bits(&[b]);
            }
            let bytes = s.take_received();
            if !bytes.is_empty() {
                let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                let _ = writeln!(err, "{{\"ev\":\"rx\",\"t\":{:.4},\"hex\":\"{hex}\"}}", t(n));
            }
        } else if connected_at.is_some() {
            // No V.42, or it went transparent: start-stop characters, and what
            // the detection phase heard first.
            let mut drained = drained;
            if let Some(s) = stack.as_mut() {
                let mut early = s.take_unclaimed();
                early.extend(drained);
                drained = early;
            }
            let bytes: Vec<u8> = drained.into_iter().filter_map(|b| deframe.feed(b)).collect();
            if !bytes.is_empty() {
                let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                let _ = writeln!(err, "{{\"ev\":\"rx\",\"t\":{:.4},\"hex\":\"{hex}\"}}", t(n));
            }
        }
    }
    let _ = writeln!(err, "{{\"ev\":\"end\",\"t\":{:.4},\"phase\":\"{}\",\"status\":\"{}\"}}", t(n), esc(&peer.phase()), esc(&peer.status()));
}
