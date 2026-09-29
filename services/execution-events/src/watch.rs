//! What the sidecar forwards. Filtering happens here, next to the node, so Setra only receives logs
//! that can be payments to a monitored wallet: stablecoin `Transfer`s to a watched recipient, and
//! SetraPaymentIntent events naming a watched merchant.

use std::collections::HashSet;

use serde::Deserialize;

pub type Addr = [u8; 20];
pub type H256 = [u8; 32];

/// keccak256("Transfer(address,address,uint256)")
pub const TRANSFER_TOPIC: H256 = hex_literal("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");

#[derive(Debug, Clone, Default)]
pub struct Watch {
    /// Token contracts whose `Transfer` logs matter (the registry's stablecoins on this chain).
    pub tokens: HashSet<Addr>,
    /// Payment intent contract(s) and the topic0 values of their Paid/Refunded events.
    pub intent_contracts: HashSet<Addr>,
    pub intent_topics: HashSet<H256>,
    /// Monitored recipients. `None` forwards every recipient (validation mode only).
    pub recipients: Option<HashSet<Addr>>,
}

impl Watch {
    fn recipient_ok(&self, topic: &H256) -> bool {
        match &self.recipients {
            None => true,
            Some(set) => {
                let mut a = [0u8; 20];
                a.copy_from_slice(&topic[12..]);
                set.contains(&a)
            }
        }
    }

    /// Decide from the log's address and topics alone (no data copy needed).
    pub fn relevant(&self, address: &Addr, topics: &[H256]) -> bool {
        if self.tokens.contains(address) {
            // ERC-20 Transfer(from indexed, to indexed, value): exactly three topics.
            return topics.len() == 3 && topics[0] == TRANSFER_TOPIC && self.recipient_ok(&topics[2]);
        }
        if self.intent_contracts.contains(address) {
            // PaymentIntentPaid/Refunded(intentId indexed, merchant indexed, payer indexed, ...).
            return topics.len() >= 3 && self.intent_topics.contains(&topics[0]) && self.recipient_ok(&topics[2]);
        }
        false
    }
}

/// The watchlist Setra serves at GET /v1/internal/execution-events/watchlist.
#[derive(Debug, Deserialize)]
pub struct WatchlistDto {
    pub chain_id: u64,
    pub tokens: Vec<String>,
    #[serde(default)]
    pub intent_contracts: Vec<String>,
    #[serde(default)]
    pub intent_topics: Vec<String>,
    pub recipients: Vec<String>,
}

impl WatchlistDto {
    pub fn into_watch(self) -> Result<Watch, String> {
        Ok(Watch {
            tokens: self.tokens.iter().map(|s| parse_addr(s)).collect::<Result<_, _>>()?,
            intent_contracts: self.intent_contracts.iter().map(|s| parse_addr(s)).collect::<Result<_, _>>()?,
            intent_topics: self.intent_topics.iter().map(|s| parse_h256(s)).collect::<Result<_, _>>()?,
            recipients: Some(self.recipients.iter().map(|s| parse_addr(s)).collect::<Result<_, _>>()?),
        })
    }
}

pub fn parse_addr(s: &str) -> Result<Addr, String> {
    let bytes = hex::decode(s.trim_start_matches("0x")).map_err(|e| format!("bad address {s}: {e}"))?;
    bytes.try_into().map_err(|_| format!("bad address length: {s}"))
}

pub fn parse_h256(s: &str) -> Result<H256, String> {
    let bytes = hex::decode(s.trim_start_matches("0x")).map_err(|e| format!("bad hash {s}: {e}"))?;
    bytes.try_into().map_err(|_| format!("bad hash length: {s}"))
}

pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

const fn hex_literal(s: &str) -> H256 {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nibble(b[2 * i]) << 4) | nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("invalid hex"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn topic_for(addr: Addr) -> H256 {
        let mut t = [0u8; 32];
        t[12..].copy_from_slice(&addr);
        t
    }

    #[test]
    fn transfer_to_watched_recipient_is_relevant_and_nothing_else_is() {
        let token = [1u8; 20];
        let merchant = [2u8; 20];
        let stranger = [3u8; 20];
        let watch = Watch { tokens: [token].into(), recipients: Some([merchant].into()), ..Default::default() };
        let from = topic_for([9u8; 20]);
        assert!(watch.relevant(&token, &[TRANSFER_TOPIC, from, topic_for(merchant)]));
        assert!(!watch.relevant(&token, &[TRANSFER_TOPIC, from, topic_for(stranger)]), "other recipients are filtered");
        assert!(!watch.relevant(&[7u8; 20], &[TRANSFER_TOPIC, from, topic_for(merchant)]), "unsupported tokens are filtered");
        assert!(!watch.relevant(&token, &[TRANSFER_TOPIC, from, topic_for(merchant), [0u8; 32]]), "ERC-721 transfers have four topics");
        assert!(!watch.relevant(&token, &[[5u8; 32], from, topic_for(merchant)]), "other events on the token are filtered");
    }

    #[test]
    fn intent_events_match_on_merchant_topic() {
        let intent = [4u8; 20];
        let paid = [6u8; 32];
        let merchant = [2u8; 20];
        let watch = Watch { intent_contracts: [intent].into(), intent_topics: [paid].into(), recipients: Some([merchant].into()), ..Default::default() };
        assert!(watch.relevant(&intent, &[paid, [0u8; 32], topic_for(merchant), topic_for([8u8; 20])]));
        assert!(!watch.relevant(&intent, &[paid, [0u8; 32], topic_for([3u8; 20]), topic_for([8u8; 20])]));
    }

    #[test]
    fn transfer_topic_constant_is_correct() {
        assert_eq!(hex::encode(TRANSFER_TOPIC), "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    }
}
