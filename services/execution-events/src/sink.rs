//! Where signals go: NDJSON on stdout (validation, piping) or batched HTTP to Setra.
//!
//! HTTP delivery is at-least-once and bounded: batches are retried with backoff, and if the backlog
//! exceeds its limit the oldest signals are discarded and a `delivery_backlog` gap is sent instead,
//! so Setra never believes the stream was complete when it was not. Setra deduplicates repeats.

use std::{
    collections::VecDeque,
    io::Write,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::tracker::{GapReason, Signal, Stats};

pub fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

fn stamp(signal: &Signal) -> Value {
    let mut v = serde_json::to_value(signal).expect("signal serializes");
    v["emitted_at_ns"] = json!(now_ns().to_string());
    v
}

pub trait Sink {
    fn send(&mut self, signal: &Signal);
    /// Called often; implementations decide whether a flush is due.
    fn tick(&mut self, stats: &Stats, force: bool);
}

pub struct StdoutSink;

impl Sink for StdoutSink {
    fn send(&mut self, signal: &Signal) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", stamp(signal));
    }
    fn tick(&mut self, _stats: &Stats, _force: bool) {}
}

pub struct HttpSink {
    url: String,
    token: String,
    chain_id: u64,
    sidecar_id: String,
    backlog: VecDeque<Value>,
    max_backlog: usize,
    last_flush: Instant,
    retry_at: Instant,
    backoff: Duration,
    dropped: bool,
    agent: ureq::Agent,
    pub delivered: u64,
    pub failures: u64,
}

impl HttpSink {
    pub fn new(base_url: &str, token: String, chain_id: u64, sidecar_id: String, max_backlog: usize) -> Self {
        HttpSink {
            url: format!("{}/v1/internal/execution-events", base_url.trim_end_matches('/')),
            token,
            chain_id,
            sidecar_id,
            backlog: VecDeque::new(),
            max_backlog,
            last_flush: Instant::now(),
            retry_at: Instant::now(),
            backoff: Duration::from_millis(250),
            dropped: false,
            agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(5)).build(),
            delivered: 0,
            failures: 0,
        }
    }

    fn post(&mut self, stats: &Stats) -> bool {
        let batch: Vec<Value> = self.backlog.iter().take(500).cloned().collect();
        let body = json!({ "chain_id": self.chain_id, "sidecar_id": self.sidecar_id, "stats": stats, "signals": batch });
        match self.agent.post(&self.url).set("authorization", &format!("Bearer {}", self.token)).send_json(body) {
            Ok(_) => {
                for _ in 0..batch.len() {
                    self.backlog.pop_front();
                }
                self.delivered += batch.len() as u64;
                self.backoff = Duration::from_millis(250);
                true
            }
            Err(ureq::Error::Status(code, response)) if (400..500).contains(&code) && code != 429 => {
                // Setra refused the batch (bad token, unmonitored chain, invalid data): a configuration
                // problem that retrying cannot fix. Exit so the supervisor restarts and alerts.
                let body = response.into_string().unwrap_or_default();
                eprintln!("{{\"level\":\"error\",\"event\":\"rejected_by_setra\",\"status\":{code},\"body\":{:?}}}", body.chars().take(300).collect::<String>());
                std::process::exit(3);
            }
            Err(e) => {
                self.failures += 1;
                eprintln!("{{\"level\":\"warn\",\"event\":\"delivery_failed\",\"error\":{:?},\"backlog\":{}}}", e.to_string(), self.backlog.len());
                self.retry_at = Instant::now() + self.backoff;
                self.backoff = (self.backoff * 2).min(Duration::from_secs(10));
                false
            }
        }
    }
}

impl Sink for HttpSink {
    fn send(&mut self, signal: &Signal) {
        if self.backlog.len() >= self.max_backlog {
            self.backlog.pop_front();
            if !self.dropped {
                self.dropped = true;
            }
        }
        self.backlog.push_back(stamp(signal));
        if self.dropped {
            // Tell Setra this stream is incomplete; RPC ingestion covers the range.
            self.dropped = false;
            let gap = Signal::Gap { reason: GapReason::DeliveryBacklog, chain_id: Some(self.chain_id), last_complete_block: None, last_seqno: None };
            self.backlog.push_back(stamp(&gap));
        }
    }

    fn tick(&mut self, stats: &Stats, force: bool) {
        let now = Instant::now();
        if now < self.retry_at && !force {
            return;
        }
        let has_payments = !self.backlog.is_empty();
        // Payment signals go out immediately; otherwise a heartbeat with stats every 5 s.
        if has_payments || force || now.duration_since(self.last_flush) >= Duration::from_secs(5) {
            self.last_flush = now;
            while self.post(stats) && !self.backlog.is_empty() {}
        }
    }
}
