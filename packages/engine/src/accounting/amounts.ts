import { toBaseUnits, MoneyError } from "@setra/schemas";
import { EngineError } from "../context";
import { LEDGER_DECIMALS } from "./chart";

/** Parse a decimal amount ("800.00") into ledger micro-units. */
export function ledgerAmount(value: string, what = "Amount"): bigint {
  try {
    const v = toBaseUnits(value, LEDGER_DECIMALS);
    if (v <= 0n) throw new EngineError("invalid_amount", `${what} must be greater than zero.`, 422);
    return v;
  } catch (error) {
    if (error instanceof MoneyError) throw new EngineError("invalid_amount", `${what}: ${error.message}`, 422);
    throw error;
  }
}
