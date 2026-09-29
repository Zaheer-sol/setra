// Cross-checks the sidecar's output on an official execution-event snapshot against a canonical RPC
// node: every token Transfer the sidecar emitted must exist on chain with the same block hash,
// transaction hash, transaction index, block-wide log index, sender, recipient and amount, and the
// sidecar must not have missed any.
//
//   node scripts/validate-snapshot.mjs <sidecar.ndjson> <rpc-url> <token> <fromBlock> <toBlock>
import { readFileSync } from "node:fs";

const [file, rpc, token, fromBlock, toBlock] = process.argv.slice(2);
if (!toBlock) {
  console.error("usage: validate-snapshot.mjs <sidecar.ndjson> <rpc-url> <token> <fromBlock> <toBlock>");
  process.exit(2);
}
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hex = (n) => `0x${BigInt(n).toString(16)}`;

async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const key = (x) => `${x.block}:${x.logIndex}`;
const norm = (l) => ({
  block: BigInt(l.blockNumber ?? l.block_number),
  blockHash: (l.blockHash ?? l.block_hash).toLowerCase(),
  tx: (l.transactionHash ?? l.transaction_hash).toLowerCase(),
  txIndex: Number(l.transactionIndex ?? l.transaction_index),
  logIndex: Number(l.logIndex ?? l.log_index),
  from: `0x${l.topics[1].slice(26)}`.toLowerCase(),
  to: `0x${l.topics[2].slice(26)}`.toLowerCase(),
  amount: BigInt(l.data)
});

const emitted = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((s) => s.kind === "log").map(norm);

// Canonical logs, in chunks the provider accepts.
const canonical = [];
for (let b = BigInt(fromBlock); b <= BigInt(toBlock); b += 10n) {
  const end = b + 9n > BigInt(toBlock) ? BigInt(toBlock) : b + 9n;
  const logs = await call("eth_getLogs", [{ fromBlock: hex(b), toBlock: hex(end), address: token, topics: [TRANSFER] }]);
  canonical.push(...logs.filter((l) => l.topics.length === 3 && BigInt(l.data) !== 0n).map(norm));
}

const byKey = new Map(canonical.map((l) => [key(l), l]));
const mismatches = [];
for (const e of emitted) {
  const c = byKey.get(key(e));
  if (!c) mismatches.push({ kind: "not_on_chain", e });
  else for (const f of ["blockHash", "tx", "txIndex", "from", "to", "amount"]) if (String(c[f]) !== String(e[f])) mismatches.push({ kind: `field:${f}`, e: String(e[f]), c: String(c[f]), at: key(e) });
}
const emittedKeys = new Set(emitted.map(key));
const missed = canonical.filter((c) => !emittedKeys.has(key(c)));

const result = {
  blocks: `${fromBlock}-${toBlock}`,
  token,
  sidecar_transfers: emitted.length,
  canonical_transfers: canonical.length,
  exact_matches: emitted.length - new Set(mismatches.map((m) => m.at ?? key(m.e))).size,
  mismatches: mismatches.length,
  missed_by_sidecar: missed.length,
  sample: emitted[0] && { block: String(emitted[0].block), tx: emitted[0].tx, logIndex: emitted[0].logIndex, amount: String(emitted[0].amount) }
};
console.log(JSON.stringify(result, null, 2));
if (mismatches.length || missed.length) {
  console.error(JSON.stringify({ mismatches: mismatches.slice(0, 5), missed: missed.slice(0, 5) }, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
  process.exit(1);
}
