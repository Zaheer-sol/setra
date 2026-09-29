import { decodeEventLog, encodeEventTopics, type Hex, type Log } from "viem";
import { ERC20_ABI, PAYMENT_INTENT_ABI } from "@setra/contracts-client";
import type { ChainAdapter } from "./adapter";

/** One blockchain fact relevant to a monitored wallet, normalized. */
export type Activity =
  | (ActivityBase & { kind: "transfer"; token: Hex; from: Hex; to: Hex; amount: bigint })
  | (ActivityBase & { kind: "intent_paid"; intentId: Hex; merchant: Hex; payer: Hex; token: Hex; amount: bigint; ref: Hex })
  | (ActivityBase & { kind: "intent_refunded"; intentId: Hex; merchant: Hex; payer: Hex; token: Hex; amount: bigint; ref: Hex });

interface ActivityBase {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  emitter: Hex;
  raw: Record<string, unknown>;
}

export interface ActivityQuery {
  fromBlock: bigint;
  toBlock: bigint;
  /** Lowercase monitored wallet addresses. */
  wallets: Hex[];
  /** Registry token contracts to watch (all known stablecoins on the chain, enabled or not, enables wrong-token detection). */
  tokens: Hex[];
  /** SetraPaymentIntent deployment on this chain, if any. */
  intentContract?: Hex;
  /** Also fetch token transfers *sent from* the wallets (evidence for refunds). */
  outgoing?: boolean;
}

const TRANSFER_TOPIC = encodeEventTopics({ abi: ERC20_ABI, eventName: "Transfer" })[0] as Hex;
const PAID_TOPIC = encodeEventTopics({ abi: PAYMENT_INTENT_ABI, eventName: "PaymentIntentPaid" })[0] as Hex;
const REFUNDED_TOPIC = encodeEventTopics({ abi: PAYMENT_INTENT_ABI, eventName: "PaymentIntentRefunded" })[0] as Hex;

/** Topic arrays with many OR'd addresses are rejected by some providers; keep groups small. */
const ADDRESS_GROUP = 50;

const padTopic = (address: Hex) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function jsonSafe(log: Log): Record<string, unknown> {
  return JSON.parse(JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * Fetch every relevant fact for the monitored wallets in [fromBlock, toBlock].
 * Splits the range by the provider's getLogs limit and the wallet list into topic groups.
 * Results are ordered canonically (block, tx index, log index).
 */
export async function fetchActivity(adapter: ChainAdapter, query: ActivityQuery): Promise<Activity[]> {
  if (query.wallets.length === 0 || query.fromBlock > query.toBlock) return [];
  const span = BigInt(adapter.network.logsBlockRange);
  const logs: Log[] = [];
  for (let start = query.fromBlock; start <= query.toBlock; start += span) {
    const end = start + span - 1n > query.toBlock ? query.toBlock : start + span - 1n;
    for (const group of chunks(query.wallets, ADDRESS_GROUP)) {
      const recipients = group.map(padTopic);
      if (query.tokens.length) {
        logs.push(...(await adapter.getLogs({ fromBlock: start, toBlock: end, address: query.tokens, topics: [TRANSFER_TOPIC, null, recipients] })));
        if (query.outgoing) {
          logs.push(...(await adapter.getLogs({ fromBlock: start, toBlock: end, address: query.tokens, topics: [TRANSFER_TOPIC, recipients, null] })));
        }
      }
      if (query.intentContract) {
        // PaymentIntentPaid/Refunded index (intentId, merchant, payer): the merchant is topic 2.
        logs.push(...(await adapter.getLogs({ fromBlock: start, toBlock: end, address: query.intentContract, topics: [[PAID_TOPIC, REFUNDED_TOPIC], null, recipients] })));
      }
    }
  }

  const unique = new Map<string, Log>();
  for (const log of logs) {
    if (log.removed || log.blockNumber == null || !log.blockHash || !log.transactionHash || log.logIndex == null || log.transactionIndex == null) continue;
    unique.set(`${log.blockHash}:${log.logIndex}`, log);
  }

  const timestamps = new Map<bigint, bigint>();
  const activities: Activity[] = [];
  for (const log of unique.values()) {
    const blockNumber = BigInt(log.blockNumber!);
    let ts = timestamps.get(blockNumber);
    if (ts === undefined) {
      ts = (await adapter.getBlock(blockNumber)).timestamp;
      timestamps.set(blockNumber, ts);
    }
    const decoded = decodeActivity(adapter.network.chainId, log, ts);
    if (decoded) activities.push(decoded);
  }
  return activities.sort((a, b) =>
    a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex
  );
}

/** Decode a raw log into an Activity. Returns null for logs that aren't ours or can't be decoded (e.g. ERC-721 Transfer). */
export function decodeActivity(chainId: number, log: Log, blockTimestamp: bigint): Activity | null {
  const base: ActivityBase = {
    chainId,
    blockNumber: BigInt(log.blockNumber!),
    blockHash: log.blockHash!.toLowerCase() as Hex,
    blockTimestamp,
    transactionHash: log.transactionHash!.toLowerCase() as Hex,
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    emitter: log.address.toLowerCase() as Hex,
    raw: jsonSafe(log)
  };
  const topic0 = log.topics[0];
  try {
    if (topic0 === TRANSFER_TOPIC) {
      if (log.topics.length !== 3) return null; // ERC-721 transfers index the token id
      const { args } = decodeEventLog({ abi: ERC20_ABI, eventName: "Transfer", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (args.value === 0n) return null; // zero-value transfers are address-poisoning noise, never payments
      return { ...base, kind: "transfer", token: base.emitter, from: args.from.toLowerCase() as Hex, to: args.to.toLowerCase() as Hex, amount: args.value };
    }
    if (topic0 === PAID_TOPIC || topic0 === REFUNDED_TOPIC) {
      const eventName = topic0 === PAID_TOPIC ? "PaymentIntentPaid" : "PaymentIntentRefunded";
      const { args } = decodeEventLog({ abi: PAYMENT_INTENT_ABI, eventName, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const a = args as { intentId: Hex; merchant: Hex; payer: Hex; token: Hex; amount: bigint; ref: Hex };
      return {
        ...base,
        kind: topic0 === PAID_TOPIC ? "intent_paid" : "intent_refunded",
        intentId: a.intentId.toLowerCase() as Hex,
        merchant: a.merchant.toLowerCase() as Hex,
        payer: a.payer.toLowerCase() as Hex,
        token: a.token.toLowerCase() as Hex,
        amount: a.amount,
        ref: a.ref.toLowerCase() as Hex
      };
    }
  } catch {
    return null;
  }
  return null;
}

export const TOPICS = { TRANSFER_TOPIC, PAID_TOPIC, REFUNDED_TOPIC };
