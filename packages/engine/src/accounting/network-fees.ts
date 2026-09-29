import type { ChainAdapter } from "@setra/blockchain";
import { withSystem, withTenant, type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { log, SYSTEM } from "../context";
import { nativeAccount, systemAccount, type BooksSettings } from "./chart";
import { accountSafely } from "./posting-rules";
import { convert, rateSource, requireRate } from "./exchange-rates";
import { isoDate, postEntry } from "./ledger";

type Row = Record<string, any>;

/**
 * Network fees. When stablecoin leaves a monitored wallet, the worker looks up who sent the
 * transaction and the gas it paid. If the wallet paid, the fee is recorded in the native token and
 * posted to Network Fees, valued with a MON (or ETH) rate the business entered. With no rate it
 * waits as an accounting issue until one exists; Setra never guesses a token price.
 */

const NATIVE_DECIMALS = 18;

export async function recordNetworkFee(
  client: Client,
  input: { organizationId: string; environment: Environment; walletId: string; chainId: number; transactionHash: string; nativeSymbol: string; feeNative: bigint; paidByWallet: boolean; blockTimestamp: Date; outgoingTransferId?: string | null }
): Promise<string | null> {
  const inserted = await client.query(
    `INSERT INTO network_fees (id, organization_id, environment, wallet_id, chain_id, transaction_hash, native_symbol, fee_native, paid_by_wallet, block_timestamp, outgoing_transfer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (organization_id, chain_id, transaction_hash) DO NOTHING RETURNING id`,
    [newId("networkFee"), input.organizationId, input.environment, input.walletId, input.chainId, input.transactionHash.toLowerCase(), input.nativeSymbol, input.feeNative.toString(), input.paidByWallet, input.blockTimestamp, input.outgoingTransferId ?? null]
  );
  const id = (inserted.rows[0]?.id as string | undefined) ?? null;
  if (id && input.paidByWallet && input.feeNative > 0n) await accountForNetworkFee(client, id);
  return id;
}

export async function accountForNetworkFee(client: Client, feeId: string): Promise<void> {
  const fee = (await client.query("SELECT * FROM network_fees WHERE id = $1", [feeId])).rows[0] as Row | undefined;
  if (!fee || !fee.paid_by_wallet || BigInt(fee.fee_native) === 0n) return;
  await accountSafely(client, { organizationId: fee.organization_id, environment: fee.environment, sourceKey: `gas:${fee.id}`, sourceType: "network_fee", sourceId: fee.id }, (s) => postNetworkFee(client, s, fee));
}

export async function postNetworkFee(client: Client, s: BooksSettings, fee: Row): Promise<{ created: boolean } | null> {
  if (!fee.paid_by_wallet || BigInt(fee.fee_native) === 0n) return null;
  const date = isoDate(new Date(fee.block_timestamp));
  const rate = await requireRate(client, fee.organization_id, fee.native_symbol, s.reportingCurrency, date);
  const amount = convert(BigInt(fee.fee_native), NATIVE_DECIMALS, rate.rate);
  if (amount === 0n) return null; // below a millionth of a dollar: nothing to post
  const expense = await systemAccount(client, fee.organization_id, fee.environment, "network_fees");
  const gas = await nativeAccount(client, fee.organization_id, fee.environment, fee.wallet_id, fee.native_symbol);
  const refs = { assetId: null, assetAmount: BigInt(fee.fee_native), rateSource: rateSource(rate), outgoingTransferId: fee.outgoing_transfer_id ?? null };
  const r = await postEntry(client, {
    organizationId: fee.organization_id,
    environment: fee.environment,
    date,
    description: `Network fee for transaction ${fee.transaction_hash.slice(0, 10)}…`,
    memo: `${fee.native_symbol} valued at ${rate.rate} ${rate.quote} (${rate.source === "manual" ? "your rate" : rate.source.toUpperCase()}, ${rate.rateDate}).`,
    sourceType: "network_fee",
    sourceId: fee.id,
    sourceKey: `gas:${fee.id}`,
    actor: SYSTEM,
    lines: [
      { ...refs, accountId: expense.id, debit: amount, memo: "Gas paid by the wallet" },
      { ...refs, accountId: gas.id, credit: amount, memo: `${fee.native_symbol} spent on gas` }
    ]
  });
  return { created: r.created };
}

/**
 * Worker job: for outgoing transfers on this chain that don't have a fee record yet, look up the
 * transaction and record the fee. A few per tick, so a backlog never starves ingestion.
 */

export async function collectNetworkFees(adapter: ChainAdapter, limit = 25): Promise<number> {
  if (!adapter.getTransactionFee) return 0;
  const chainId = adapter.network.chainId;
  const pending = await withSystem(async (c) =>
    (
      await c.query(
        `SELECT DISTINCT ON (t.organization_id, t.transaction_hash) t.id, t.organization_id, t.environment, t.wallet_id, t.transaction_hash, t.block_timestamp, w.address
           FROM outgoing_transfers t JOIN wallets w ON w.id = t.wallet_id
          WHERE t.chain_id = $1 AND t.canonical
            AND NOT EXISTS (SELECT 1 FROM network_fees f WHERE f.organization_id = t.organization_id AND f.chain_id = t.chain_id AND f.transaction_hash = t.transaction_hash)
          ORDER BY t.organization_id, t.transaction_hash, t.id LIMIT $2`,
        [chainId, limit]
      )
    ).rows as Row[]
  );
  let recorded = 0;
  for (const t of pending) {
    const fee = await adapter.getTransactionFee(t.transaction_hash as `0x${string}`);
    if (!fee) continue;
    const paidByWallet = fee.from === String(t.address).toLowerCase();
    const id = await withTenant(t.organization_id, (c) =>
      recordNetworkFee(c, { organizationId: t.organization_id, environment: t.environment, walletId: t.wallet_id, chainId, transactionHash: t.transaction_hash, nativeSymbol: adapter.network.nativeSymbol, feeNative: paidByWallet ? fee.fee : 0n, paidByWallet, blockTimestamp: new Date(t.block_timestamp), outgoingTransferId: t.id })
    );
    if (id) recorded += 1;
  }
  if (recorded) log().info("network_fees_recorded", { chainId, recorded });
  return recorded;
}
