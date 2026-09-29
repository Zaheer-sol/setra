//! Setra execution-events sidecar.
//!
//! Runs on the same host as a Monad node, reads the execution daemon's event ring through the
//! official SDK (`monad-event-ring` / `monad-exec-events`), keeps only payment-relevant logs for
//! wallets Setra monitors, and forwards them to Setra as provisional observations. Settlement stays
//! with Setra's canonical RPC path; this process only makes detection faster.
//!
//!   # live ring on a node host (default ring name, or a path):
//!   setra-exec-sidecar --chain-id 10143 --setra-url http://setra-api:4000   (token in SETRA_EXEC_EVENTS_TOKEN)
//!   # replay an official snapshot and print every USDC transfer (validation):
//!   setra-exec-sidecar --event-ring-path ./testdata/x.zst --token 0xa0b8… --all-recipients --stdout

mod sink;
mod tracker;
mod watch;

use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
    thread,
    time::{Duration, Instant},
};

use clap::Parser;
use monad_event_ring::{DecodedEventRing, EventDescriptor, EventNextResult, EventPayloadResult, EventRingPath};
use monad_exec_events::{ffi::DEFAULT_FILE_NAME, ExecEvent, ExecEventDecoder, ExecEventReaderExt, ExecEventRef, ExecEventRing, ExecEventType, ExecSnapshotEventRing};

use crate::{
    sink::{HttpSink, Sink, StdoutSink},
    tracker::{CommitState, GapReason, Input, Signal, Tracker},
    watch::{parse_addr, Watch, WatchlistDto},
};

#[derive(Debug, Parser)]
#[command(name = "setra-exec-sidecar", about = "Forward Monad execution events for monitored wallets to Setra")]
struct Cli {
    /// Event ring file: a live ring (default: the execution daemon's default ring) or a `.zst` snapshot.
    #[arg(long)]
    event_ring_path: Option<PathBuf>,
    /// Setra API base URL. Signals are POSTed to /v1/internal/execution-events.
    #[arg(long, env = "SETRA_URL")]
    setra_url: Option<String>,
    /// Shared secret matching Setra's EXEC_EVENTS_INGEST_TOKEN.
    #[arg(long, env = "SETRA_EXEC_EVENTS_TOKEN", hide_env_values = true)]
    ingest_token: Option<String>,
    /// Chain this node executes (143 Monad mainnet, 10143 Monad testnet). Signals from any other chain are refused.
    #[arg(long)]
    chain_id: Option<u64>,
    /// Print signals as NDJSON instead of sending them to Setra.
    #[arg(long)]
    stdout: bool,
    /// Static filter (instead of Setra's watchlist): token contracts to watch.
    #[arg(long = "token")]
    tokens: Vec<String>,
    /// Static filter: recipient wallets to watch.
    #[arg(long = "recipient")]
    recipients: Vec<String>,
    /// Validation only: forward transfers to every recipient.
    #[arg(long)]
    all_recipients: bool,
    /// Warn when a live ring produces no events for this long.
    #[arg(long, default_value_t = 5)]
    stall_seconds: u64,
}

enum Ring {
    Live(ExecEventRing),
    Snapshot(ExecSnapshotEventRing),
}

fn log(level: &str, event: &str, fields: serde_json::Value) {
    let mut v = serde_json::json!({ "level": level, "service": "setra-exec-sidecar", "event": event });
    if let (Some(obj), Some(extra)) = (v.as_object_mut(), fields.as_object()) {
        obj.extend(extra.clone());
    }
    eprintln!("{v}");
}

fn main() {
    let cli = Cli::parse();
    let fail = |what: &str, e: String| -> ! {
        log("error", "sidecar_open_failed", serde_json::json!({ "step": what, "error": e }));
        std::process::exit(1)
    };
    let path = EventRingPath::resolve(cli.event_ring_path.clone().unwrap_or(PathBuf::from(DEFAULT_FILE_NAME))).unwrap_or_else(|e| fail("resolve event ring path", e.to_string()));
    // The SDK verifies the ring's content type and schema hash on open and refuses incompatible data.
    let ring = match path.is_snapshot_file() {
        Ok(true) => Ring::Snapshot(ExecSnapshotEventRing::new_from_zstd_path(path, None).unwrap_or_else(|e| fail("open snapshot", e.to_string()))),
        Ok(false) => Ring::Live(ExecEventRing::new(path).unwrap_or_else(|e| fail("open live event ring (is the node running with execution events enabled?)", e.to_string()))),
        Err(e) => fail("inspect event ring file", e.to_string()),
    };
    let live = matches!(ring, Ring::Live(_));

    // Filter: static (CLI) or Setra's watchlist, refreshed in the background.
    let watch = Arc::new(RwLock::new(static_watch(&cli)));
    let use_setra = !cli.stdout && cli.setra_url.is_some();
    let mut sink: Box<dyn Sink> = if use_setra {
        let chain_id = cli.chain_id.expect("--chain-id is required when sending to Setra");
        let token = cli.ingest_token.clone().expect("SETRA_EXEC_EVENTS_TOKEN is required when sending to Setra");
        let url = cli.setra_url.clone().unwrap();
        if cli.tokens.is_empty() {
            spawn_watchlist_refresh(url.clone(), token.clone(), chain_id, watch.clone());
        }
        Box::new(HttpSink::new(&url, token, chain_id, format!("{}-{}", hostname(), std::process::id()), 10_000))
    } else {
        Box::new(StdoutSink)
    };

    let mut tracker = Tracker::new();
    let mut reader = match &ring {
        Ring::Live(r) => {
            let mut rd = r.create_reader();
            // Start on a block boundary; anything before this point was not seen by this process.
            rd.consensus_prev(Some(ExecEventType::BlockStart));
            rd
        }
        Ring::Snapshot(s) => s.create_reader(),
    };
    if live {
        tracker.push(Input::Gap { reason: GapReason::SidecarStart }, None);
    }
    log("info", "sidecar_started", serde_json::json!({ "mode": if live { "live" } else { "snapshot" }, "sink": if use_setra { "setra" } else { "stdout" } }));

    let started = Instant::now();
    let mut last_event = Instant::now();
    let mut stalled = false;
    loop {
        match reader.next_descriptor() {
            EventNextResult::Gap => {
                log("warn", "execution_event_gap", serde_json::json!({ "last_seqno": tracker.stats.last_seqno }));
                tracker.push(Input::Gap { reason: GapReason::SequenceGap }, None);
                reader.reset();
            }
            EventNextResult::NotReady => {
                if !live {
                    break; // a snapshot is finished the first time it is not ready
                }
                if last_event.elapsed() > Duration::from_secs(cli.stall_seconds) && !stalled {
                    stalled = true;
                    log("warn", "execution_events_stalled", serde_json::json!({ "seconds": cli.stall_seconds }));
                }
                sink.tick(&tracker.stats, false);
                thread::sleep(Duration::from_micros(100));
            }
            EventNextResult::Ready(desc) => {
                last_event = Instant::now();
                stalled = false;
                let input = {
                    let w = watch.read().unwrap();
                    normalize(&desc, &w)
                };
                let expired = matches!(input, Input::Gap { reason: GapReason::PayloadExpired });
                let w = watch.read().unwrap().clone();
                tracker.push(input, Some(&w));
                if expired {
                    reader.reset();
                }
            }
        }
        let signals = tracker.drain();
        let ends_batch = !signals.is_empty();
        for s in &signals {
            if let (Signal::Log { chain_id, .. }, Some(expected)) = (s, cli.chain_id) {
                if *chain_id != expected {
                    log("error", "wrong_chain", serde_json::json!({ "expected": expected, "got": chain_id }));
                    std::process::exit(2);
                }
            }
            sink.send(s);
        }
        if ends_batch {
            sink.tick(&tracker.stats, false);
        }
    }
    sink.tick(&tracker.stats, true);
    let elapsed = started.elapsed().as_secs_f64();
    log(
        "info",
        "sidecar_finished",
        serde_json::json!({
            "events_consumed": tracker.stats.events_consumed,
            "events_relevant": tracker.stats.events_relevant,
            "payment_signals": tracker.stats.payment_signals,
            "gaps": tracker.stats.gaps,
            "last_block_number": tracker.stats.last_block_number,
            "blocks_executed": tracker.stats.blocks_executed,
            "blocks_voted": tracker.stats.blocks_voted,
            "blocks_finalized": tracker.stats.blocks_finalized,
            "blocks_verified": tracker.stats.blocks_verified,
            "seconds": elapsed,
            "events_per_second": (tracker.stats.events_consumed as f64 / elapsed.max(1e-9)).round(),
        }),
    );
}

/// What the tracker needs from one event, extracted zero-copy by the SDK's own decoder.
enum Peek {
    BlockStart(u64, [u8; 32], u64, u64),
    BlockEnd([u8; 32]),
    State(u64, Option<[u8; 32]>, CommitState),
    TxnHash([u8; 32]),
    Receipt(bool, u32),
    Log([u8; 20], Vec<[u8; 32]>),
}

fn peek(e: ExecEventRef<'_>) -> Option<Peek> {
    Some(match e {
        ExecEventRef::BlockStart(b) => Peek::BlockStart(b.block_tag.block_number, b.block_tag.id.bytes, b.eth_block_input.timestamp, b.chain_id.limbs[0]),
        ExecEventRef::BlockEnd(b) => Peek::BlockEnd(b.eth_block_hash.bytes),
        ExecEventRef::BlockQC(q) => Peek::State(q.block_tag.block_number, Some(q.block_tag.id.bytes), CommitState::Voted),
        ExecEventRef::BlockFinalized(f) => Peek::State(f.block_number, Some(f.id.bytes), CommitState::Finalized),
        ExecEventRef::BlockVerified(v) => Peek::State(v.block_number, None, CommitState::Verified),
        ExecEventRef::BlockReject(_) => Peek::State(0, None, CommitState::Rejected),
        ExecEventRef::TxnHeaderStart { txn_header_start, .. } => Peek::TxnHash(txn_header_start.txn_hash.bytes),
        ExecEventRef::TxnEvmOutput { output, .. } => Peek::Receipt(output.receipt.status, output.receipt.log_count),
        ExecEventRef::TxnLog { txn_log, topic_bytes, .. } => {
            Peek::Log(txn_log.address.bytes, topic_bytes.chunks_exact(32).take(txn_log.topic_count as usize).map(|c| c.try_into().unwrap()).collect())
        }
        _ => return None,
    })
}

/// Convert one descriptor into a tracker input. Only relevant logs are copied out of shared memory;
/// everything else is reduced zero-copy to the few fields the tracker needs.
fn normalize(desc: &EventDescriptor<'_, ExecEventDecoder>, watch: &Watch) -> Input {
    let info = desc.info();
    let seqno = info.seqno;
    let recorded_ns = info.record_epoch_nanos;
    let txn_index = info.flow_info.txn_idx;
    let peeked = match desc.try_filter_map(peek) {
        EventPayloadResult::Ready(p) => p,
        EventPayloadResult::Expired => return Input::Gap { reason: GapReason::PayloadExpired },
    };
    match (peeked, txn_index) {
        (Some(Peek::BlockStart(number, id, timestamp, chain_id)), _) => Input::BlockStart { seqno, recorded_ns, number, id, timestamp, chain_id },
        (Some(Peek::BlockEnd(eth_hash)), _) => Input::BlockEnd { seqno, recorded_ns, eth_hash },
        (Some(Peek::State(number, id, state)), _) => Input::BlockState { seqno, recorded_ns, number, id, state },
        (Some(Peek::TxnHash(hash)), Some(txn_index)) => Input::TxnHeader { seqno, txn_index, hash },
        (Some(Peek::Receipt(status, log_count)), Some(txn_index)) => Input::TxnOutput { seqno, txn_index, status, log_count },
        (Some(Peek::Log(address, topics)), Some(_)) if watch.relevant(&address, &topics) => match desc.try_read() {
            EventPayloadResult::Ready(ExecEvent::TxnLog { txn_index, txn_log, data_bytes, .. }) => {
                Input::Log { seqno, recorded_ns, txn_index, index: txn_log.index, address, topics, data: data_bytes.to_vec() }
            }
            EventPayloadResult::Ready(_) => Input::Other { seqno },
            EventPayloadResult::Expired => Input::Gap { reason: GapReason::PayloadExpired },
        },
        _ => Input::Other { seqno },
    }
}

fn static_watch(cli: &Cli) -> Watch {
    let tokens = cli.tokens.iter().map(|s| parse_addr(s).expect("valid --token")).collect();
    let recipients = if cli.all_recipients { None } else { Some(cli.recipients.iter().map(|s| parse_addr(s).expect("valid --recipient")).collect()) };
    Watch { tokens, recipients, ..Default::default() }
}

/// Keep the filter in step with the wallets Setra monitors (new wallets start being watched within seconds).
fn spawn_watchlist_refresh(base: String, token: String, chain_id: u64, watch: Arc<RwLock<Watch>>) {
    let url = format!("{}/v1/internal/execution-events/watchlist?chain_id={chain_id}", base.trim_end_matches('/'));
    let fetch = move || -> Result<Watch, String> {
        let dto: WatchlistDto = ureq::get(&url).set("authorization", &format!("Bearer {token}")).timeout(Duration::from_secs(5)).call().map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())?;
        if dto.chain_id != chain_id {
            return Err(format!("watchlist is for chain {} not {chain_id}", dto.chain_id));
        }
        dto.into_watch()
    };
    // First load is synchronous so no early payment is filtered out by an empty watchlist.
    match fetch() {
        Ok(w) => {
            log("info", "watchlist_loaded", serde_json::json!({ "recipients": w.recipients.as_ref().map(|r| r.len()), "tokens": w.tokens.len() }));
            *watch.write().unwrap() = w;
        }
        Err(e) => log("error", "watchlist_failed", serde_json::json!({ "error": e })),
    }
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(5));
        match fetch() {
            Ok(w) => *watch.write().unwrap() = w,
            Err(e) => log("warn", "watchlist_refresh_failed", serde_json::json!({ "error": e })),
        }
    });
}

fn hostname() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "sidecar".into())
}
