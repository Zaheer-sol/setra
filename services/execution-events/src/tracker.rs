//! Turns the execution event stream into Setra signals.
//!
//! Execution events describe *speculatively executed* blocks: a block's logs arrive between its
//! BLOCK_START and BLOCK_END, and its consensus fate arrives later (BLOCK_QC → voted,
//! BLOCK_FINALIZED, BLOCK_VERIFIED). The tracker:
//!
//! * assembles each block and, at BLOCK_END, emits the relevant logs with the Ethereum block hash
//!   and the block-wide log index an RPC node would report, so Setra deduplicates them against its
//!   RPC path exactly;
//! * never emits logs from reverted transactions or from blocks it did not see completely;
//! * forwards commit-state changes only for blocks that contained a relevant log;
//! * checks sequence-number continuity itself (in addition to the SDK's gap detection) and, on any
//!   gap or expired payload, drops the partial block and emits a gap so Setra marks the stream
//!   incomplete and relies on canonical RPC data for that range.
//!
//! Pure logic: no I/O, driven by `Input` values, so every path is unit-testable.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

use crate::watch::{hex0x, Addr, Watch, H256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitState {
    Voted,
    Finalized,
    Verified,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    /// The SDK reader reported a sequence gap (the ring overwrote events we had not read).
    SequenceGap,
    /// Sequence numbers were not contiguous (defensive check).
    SequenceDiscontinuity,
    /// A payload was overwritten before we could read it.
    PayloadExpired,
    /// Events for a block were incomplete (missing receipt/header or a new block started early).
    IncompleteBlock,
    /// The sidecar (re)started mid-stream; anything before now was not observed by this process.
    SidecarStart,
    /// The delivery backlog to Setra overflowed and signals were discarded.
    DeliveryBacklog,
}

#[derive(Debug, Clone)]
pub enum Input {
    BlockStart { seqno: u64, recorded_ns: u64, number: u64, id: H256, timestamp: u64, chain_id: u64 },
    TxnHeader { seqno: u64, txn_index: usize, hash: H256 },
    TxnOutput { seqno: u64, txn_index: usize, status: bool, log_count: u32 },
    /// Only relevant logs are passed with content; every other event is `Other` (for continuity).
    Log { seqno: u64, recorded_ns: u64, txn_index: usize, index: u32, address: Addr, topics: Vec<H256>, data: Vec<u8> },
    BlockEnd { seqno: u64, recorded_ns: u64, eth_hash: H256 },
    BlockState { seqno: u64, recorded_ns: u64, number: u64, id: Option<H256>, state: CommitState },
    Other { seqno: u64 },
    Gap { reason: GapReason },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Signal {
    Log {
        seqno: u64,
        chain_id: u64,
        block_number: u64,
        block_id: String,
        block_hash: String,
        block_timestamp: u64,
        transaction_hash: String,
        transaction_index: usize,
        log_index: u64,
        address: String,
        topics: Vec<String>,
        data: String,
        /// When the EVM recorded this log (event descriptor timestamp).
        #[serde(serialize_with = "as_string")]
        executed_at_ns: u64,
        /// When the block finished executing (BLOCK_END timestamp).
        #[serde(serialize_with = "as_string")]
        block_executed_at_ns: u64,
    },
    BlockState {
        seqno: u64,
        chain_id: u64,
        block_number: u64,
        block_id: Option<String>,
        state: CommitState,
        #[serde(serialize_with = "as_string")]
        recorded_at_ns: u64,
    },
    Gap {
        reason: GapReason,
        chain_id: Option<u64>,
        /// Last block this sidecar observed completely before the gap.
        last_complete_block: Option<u64>,
        last_seqno: Option<u64>,
    },
}

/// Nanosecond timestamps exceed 2^53, the largest integer JSON consumers like JavaScript represent
/// exactly, so they travel as decimal strings.
fn as_string<S: serde::Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}

#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct Stats {
    pub events_consumed: u64,
    pub events_relevant: u64,
    pub payment_signals: u64,
    pub gaps: u64,
    pub last_seqno: Option<u64>,
    pub last_block_number: Option<u64>,
    pub blocks_executed: u64,
    pub blocks_voted: u64,
    pub blocks_finalized: u64,
    pub blocks_verified: u64,
}

struct PendingLog {
    recorded_ns: u64,
    txn_index: usize,
    index: u32,
    address: Addr,
    topics: Vec<H256>,
    data: Vec<u8>,
    seqno: u64,
}

struct Block {
    number: u64,
    id: H256,
    timestamp: u64,
    chain_id: u64,
    hashes: HashMap<usize, H256>,
    outputs: HashMap<usize, (bool, u32)>,
    logs: Vec<PendingLog>,
}

pub struct Tracker {
    block: Option<Block>,
    last_seqno: Option<u64>,
    last_complete_block: Option<u64>,
    chain_id: Option<u64>,
    /// Blocks that produced relevant logs, whose commit state Setra cares about.
    interesting: VecDeque<(u64, H256)>,
    out: Vec<Signal>,
    pub stats: Stats,
}

const INTERESTING_MEMORY: usize = 512;

impl Tracker {
    pub fn new() -> Self {
        Tracker { block: None, last_seqno: None, last_complete_block: None, chain_id: None, interesting: VecDeque::new(), out: Vec::new(), stats: Stats::default() }
    }

    pub fn drain(&mut self) -> Vec<Signal> {
        std::mem::take(&mut self.out)
    }

    /// `watch` re-checks relevance for logs (the reader pre-filters; this keeps the tracker safe alone).
    pub fn push(&mut self, input: Input, watch: Option<&Watch>) {
        let fallback = Watch::default();
        let watch = watch.unwrap_or(&fallback);
        if let Some(seqno) = seqno_of(&input) {
            self.stats.events_consumed += 1;
            if let Some(last) = self.last_seqno {
                if seqno != last + 1 {
                    self.gap(GapReason::SequenceDiscontinuity);
                }
            }
            self.last_seqno = Some(seqno);
            self.stats.last_seqno = Some(seqno);
        }
        match input {
            Input::Gap { reason } => self.gap(reason),
            Input::BlockStart { number, id, timestamp, chain_id, .. } => {
                if self.block.is_some() {
                    // Execution is not pipelined: a new block before BLOCK_END means we missed events.
                    self.gap(GapReason::IncompleteBlock);
                }
                self.chain_id = Some(chain_id);
                self.block = Some(Block { number, id, timestamp, chain_id, hashes: HashMap::new(), outputs: HashMap::new(), logs: Vec::new() });
            }
            Input::TxnHeader { txn_index, hash, .. } => {
                if let Some(b) = self.block.as_mut() {
                    b.hashes.insert(txn_index, hash);
                }
            }
            Input::TxnOutput { txn_index, status, log_count, .. } => {
                if let Some(b) = self.block.as_mut() {
                    b.outputs.insert(txn_index, (status, log_count));
                }
            }
            Input::Log { seqno, recorded_ns, txn_index, index, address, topics, data } => {
                let configured = watch.recipients.is_some() || !watch.tokens.is_empty() || !watch.intent_contracts.is_empty();
                if configured && !watch.relevant(&address, &topics) {
                    return;
                }
                if let Some(b) = self.block.as_mut() {
                    self.stats.events_relevant += 1;
                    b.logs.push(PendingLog { recorded_ns, txn_index, index, address, topics, data, seqno });
                }
            }
            Input::BlockEnd { recorded_ns, eth_hash, .. } => self.end_block(recorded_ns, eth_hash),
            Input::BlockState { seqno, recorded_ns, number, id, state } => {
                match state {
                    CommitState::Voted => self.stats.blocks_voted += 1,
                    CommitState::Finalized => self.stats.blocks_finalized += 1,
                    CommitState::Verified => self.stats.blocks_verified += 1,
                    CommitState::Rejected => {}
                }
                let matches = self.interesting.iter().any(|(n, i)| match id {
                    Some(id) => *i == id,
                    None => *n == number,
                });
                if matches {
                    self.out.push(Signal::BlockState { seqno, chain_id: self.chain_id.unwrap_or(0), block_number: number, block_id: id.map(|i| hex0x(&i)), state, recorded_at_ns: recorded_ns });
                }
                if state == CommitState::Verified {
                    // Verified is terminal; forget older blocks.
                    self.interesting.retain(|(n, _)| *n > number);
                }
            }
            Input::Other { .. } => {}
        }
    }

    fn end_block(&mut self, recorded_ns: u64, eth_hash: H256) {
        let Some(b) = self.block.take() else {
            // BLOCK_END without its start: the start was lost.
            self.gap(GapReason::IncompleteBlock);
            return;
        };
        self.stats.last_block_number = Some(b.number);
        self.stats.blocks_executed += 1;
        if !b.logs.is_empty() {
            // Block-wide log index = logs of all earlier transactions + index within the transaction.
            let max_txn = b.logs.iter().map(|l| l.txn_index).max().unwrap_or(0);
            let mut prefix = vec![0u64; max_txn + 1];
            let mut complete = true;
            let mut running = 0u64;
            for t in 0..=max_txn {
                prefix[t] = running;
                match b.outputs.get(&t) {
                    Some((_, count)) => running += *count as u64,
                    None => complete = false,
                }
            }
            if !complete || b.logs.iter().any(|l| !b.hashes.contains_key(&l.txn_index)) {
                self.gap(GapReason::IncompleteBlock);
                return;
            }
            let mut logs = b.logs;
            logs.sort_by_key(|l| (l.txn_index, l.index));
            let mut emitted = false;
            for l in logs {
                let (status, _) = b.outputs[&l.txn_index];
                if !status {
                    continue; // reverted transaction: its logs are not part of the chain
                }
                emitted = true;
                self.stats.payment_signals += 1;
                self.out.push(Signal::Log {
                    seqno: l.seqno,
                    chain_id: b.chain_id,
                    block_number: b.number,
                    block_id: hex0x(&b.id),
                    block_hash: hex0x(&eth_hash),
                    block_timestamp: b.timestamp,
                    transaction_hash: hex0x(&b.hashes[&l.txn_index]),
                    transaction_index: l.txn_index,
                    log_index: prefix[l.txn_index] + l.index as u64,
                    address: hex0x(&l.address),
                    topics: l.topics.iter().map(|t| hex0x(t)).collect(),
                    data: hex0x(&l.data),
                    executed_at_ns: l.recorded_ns,
                    block_executed_at_ns: recorded_ns,
                });
            }
            if emitted {
                self.interesting.push_back((b.number, b.id));
                while self.interesting.len() > INTERESTING_MEMORY {
                    self.interesting.pop_front();
                }
            }
        }
        self.last_complete_block = Some(b.number);
    }

    fn gap(&mut self, reason: GapReason) {
        // Whatever was assembled for the current block cannot be trusted to be complete.
        self.block = None;
        self.stats.gaps += 1;
        self.out.push(Signal::Gap { reason, chain_id: self.chain_id, last_complete_block: self.last_complete_block, last_seqno: self.last_seqno });
    }
}

impl Default for Tracker {
    fn default() -> Self {
        Self::new()
    }
}

fn seqno_of(input: &Input) -> Option<u64> {
    match input {
        Input::BlockStart { seqno, .. }
        | Input::TxnHeader { seqno, .. }
        | Input::TxnOutput { seqno, .. }
        | Input::Log { seqno, .. }
        | Input::BlockEnd { seqno, .. }
        | Input::BlockState { seqno, .. }
        | Input::Other { seqno } => Some(*seqno),
        Input::Gap { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::TRANSFER_TOPIC;

    const TOKEN: Addr = [0xaa; 20];
    const MERCHANT: Addr = [0x61; 20];

    fn watch() -> Watch {
        Watch { tokens: [TOKEN].into(), recipients: Some([MERCHANT].into()), ..Default::default() }
    }

    fn topic(a: Addr) -> H256 {
        let mut t = [0u8; 32];
        t[12..].copy_from_slice(&a);
        t
    }

    struct Feed {
        seq: u64,
        t: Tracker,
        w: Watch,
    }

    impl Feed {
        fn new() -> Self {
            Feed { seq: 0, t: Tracker::new(), w: watch() }
        }
        fn next(&mut self) -> u64 {
            self.seq += 1;
            self.seq
        }
        fn start(&mut self, number: u64) {
            let s = self.next();
            self.t.push(Input::BlockStart { seqno: s, recorded_ns: 1_000, number, id: [number as u8; 32], timestamp: 1_700_000_000 + number, chain_id: 10143 }, Some(&self.w));
        }
        fn txn(&mut self, idx: usize, status: bool, logs: u32) {
            let s = self.next();
            self.t.push(Input::TxnHeader { seqno: s, txn_index: idx, hash: [idx as u8 + 0x10; 32] }, Some(&self.w));
            let s = self.next();
            self.t.push(Input::TxnOutput { seqno: s, txn_index: idx, status, log_count: logs }, Some(&self.w));
        }
        fn log(&mut self, idx: usize, index: u32, to: Addr, amount: u8) {
            let s = self.next();
            let mut data = vec![0u8; 32];
            data[31] = amount;
            self.t.push(Input::Log { seqno: s, recorded_ns: 2_000 + s, txn_index: idx, index, address: TOKEN, topics: vec![TRANSFER_TOPIC, topic([0x91; 20]), topic(to)], data }, Some(&self.w));
        }
        fn other(&mut self) {
            let s = self.next();
            self.t.push(Input::Other { seqno: s }, Some(&self.w));
        }
        fn end(&mut self) {
            let s = self.next();
            self.t.push(Input::BlockEnd { seqno: s, recorded_ns: 9_000, eth_hash: [0xbb; 32] }, Some(&self.w));
        }
        fn state(&mut self, number: u64, state: CommitState) {
            let s = self.next();
            let id = if state == CommitState::Verified { None } else { Some([number as u8; 32]) };
            self.t.push(Input::BlockState { seqno: s, recorded_ns: 10_000, number, id, state }, Some(&self.w));
        }
    }

    fn logs(signals: &[Signal]) -> Vec<(u64, u64, String)> {
        signals
            .iter()
            .filter_map(|s| match s {
                Signal::Log { block_number, log_index, transaction_hash, .. } => Some((*block_number, *log_index, transaction_hash.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn emits_relevant_logs_at_block_end_with_rpc_log_index() {
        let mut f = Feed::new();
        f.start(100);
        f.txn(0, true, 2); // two unrelated logs in txn 0
        f.other();
        f.other();
        f.txn(1, true, 3); // payment is the 2nd log of txn 1 → block log index 2 + 1 = 3
        f.other();
        f.log(1, 1, MERCHANT, 20);
        f.other();
        assert!(f.t.drain().is_empty(), "nothing is emitted before BLOCK_END");
        f.end();
        let out = f.t.drain();
        assert_eq!(logs(&out), vec![(100, 3, hex0x(&[0x11; 32]))]);
        match &out[0] {
            Signal::Log { block_hash, chain_id, block_timestamp, executed_at_ns, block_executed_at_ns, .. } => {
                assert_eq!(block_hash, &hex0x(&[0xbb; 32]));
                assert_eq!(*chain_id, 10143);
                assert_eq!(*block_timestamp, 1_700_000_100);
                assert!(*executed_at_ns > 2_000);
                assert_eq!(*block_executed_at_ns, 9_000);
            }
            _ => unreachable!(),
        }
        assert_eq!(f.t.stats.payment_signals, 1);
    }

    #[test]
    fn ignores_other_recipients_and_reverted_transactions() {
        let mut f = Feed::new();
        f.start(1);
        f.txn(0, true, 1);
        f.log(0, 0, [0x33; 20], 5); // not a monitored wallet
        f.txn(1, false, 1); // reverted
        f.log(1, 0, MERCHANT, 5);
        f.end();
        assert!(logs(&f.t.drain()).is_empty());
    }

    #[test]
    fn a_sequence_gap_drops_the_partial_block_and_reports_the_last_complete_block() {
        let mut f = Feed::new();
        f.start(10);
        f.txn(0, true, 0);
        f.end();
        f.start(11);
        f.txn(0, true, 1);
        f.log(0, 0, MERCHANT, 9);
        f.seq += 5; // five events lost
        f.end();
        let out = f.t.drain();
        assert!(logs(&out).is_empty(), "a block with lost events is never emitted");
        assert!(out.iter().any(|s| matches!(s, Signal::Gap { reason: GapReason::SequenceDiscontinuity, last_complete_block: Some(10), .. })));
        // The stream continues: the next complete block is processed normally.
        f.start(12);
        f.txn(0, true, 1);
        f.log(0, 0, MERCHANT, 9);
        f.end();
        assert_eq!(logs(&f.t.drain()), vec![(12, 0, hex0x(&[0x10; 32]))]);
    }

    #[test]
    fn sdk_gaps_and_expired_payloads_are_reported() {
        let mut t = Tracker::new();
        t.push(Input::Gap { reason: GapReason::SequenceGap }, None);
        t.push(Input::Gap { reason: GapReason::PayloadExpired }, None);
        let reasons: Vec<_> = t.drain().into_iter().filter_map(|s| if let Signal::Gap { reason, .. } = s { Some(reason) } else { None }).collect();
        assert_eq!(reasons, vec![GapReason::SequenceGap, GapReason::PayloadExpired]);
        assert_eq!(t.stats.gaps, 2);
    }

    #[test]
    fn missing_receipts_mean_the_block_is_incomplete() {
        let mut f = Feed::new();
        f.start(5);
        // txn 0's header/output never arrive, so txn 1's log index cannot be computed.
        let s = f.next();
        f.t.push(Input::TxnHeader { seqno: s, txn_index: 1, hash: [1; 32] }, Some(&f.w.clone()));
        let s = f.next();
        f.t.push(Input::TxnOutput { seqno: s, txn_index: 1, status: true, log_count: 1 }, Some(&f.w.clone()));
        f.log(1, 0, MERCHANT, 1);
        f.end();
        let out = f.t.drain();
        assert!(logs(&out).is_empty());
        assert!(out.iter().any(|s| matches!(s, Signal::Gap { reason: GapReason::IncompleteBlock, .. })));
    }

    #[test]
    fn a_new_block_before_block_end_is_a_gap() {
        let mut f = Feed::new();
        f.start(7);
        f.txn(0, true, 1);
        f.log(0, 0, MERCHANT, 1);
        f.start(8);
        f.end();
        let out = f.t.drain();
        assert!(logs(&out).is_empty());
        assert!(out.iter().any(|s| matches!(s, Signal::Gap { reason: GapReason::IncompleteBlock, .. })));
    }

    #[test]
    fn commit_states_are_forwarded_only_for_blocks_with_payments() {
        let mut f = Feed::new();
        f.start(20);
        f.txn(0, true, 1);
        f.log(0, 0, MERCHANT, 1);
        f.end();
        f.start(21);
        f.txn(0, true, 0);
        f.end();
        f.t.drain();
        f.state(21, CommitState::Voted); // no payment in 21
        f.state(20, CommitState::Voted);
        f.state(20, CommitState::Finalized);
        f.state(20, CommitState::Verified);
        let states: Vec<_> = f.t.drain().into_iter().filter_map(|s| if let Signal::BlockState { block_number, state, .. } = s { Some((block_number, state)) } else { None }).collect();
        assert_eq!(states, vec![(20, CommitState::Voted), (20, CommitState::Finalized), (20, CommitState::Verified)]);
    }

    #[test]
    fn a_burst_of_payments_in_one_block_gets_distinct_ordered_indexes() {
        let mut f = Feed::new();
        f.start(30);
        for t in 0..200usize {
            f.txn(t, true, 1);
            f.log(t, 0, MERCHANT, (t % 250) as u8);
        }
        f.end();
        let out = logs(&f.t.drain());
        assert_eq!(out.len(), 200);
        assert!(out.windows(2).all(|w| w[0].1 + 1 == w[1].1), "log indexes are contiguous and ordered");
        assert_eq!(f.t.stats.events_relevant, 200);
    }

    #[test]
    fn replaying_the_same_block_emits_identical_signals() {
        // Setra deduplicates on (block hash, transaction, log index); the sidecar must be deterministic.
        let run = || {
            let mut f = Feed::new();
            f.start(40);
            f.txn(0, true, 1);
            f.log(0, 0, MERCHANT, 3);
            f.end();
            logs(&f.t.drain())
        };
        assert_eq!(run(), run());
    }
}
