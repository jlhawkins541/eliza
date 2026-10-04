/**
 * Turns getTokenLargestAccounts rows into share-of-supply figures with exact
 * BigInt arithmetic. The rows are the largest token ACCOUNTS, not owners, and
 * the RPC returns at most 20. Every row is kept, in RPC order; inconsistent
 * rows make the whole section a typed unknown rather than a partial table.
 */
import type { TokenAccountBalancePair } from "@solana/web3.js";
import { toHuman } from "../../sdk/tokens/decimals.js";
import type { HolderRow, Share, TokenSafetyChecks } from "./types.js";

/** Share of supply rounded down to 4 decimal places; zero supply is an explicit unknown. */
export function sharePercent(amount: bigint, supply: bigint): Share {
  if (supply === 0n) {
    return {
      status: "unknown",
      code: "TOKEN_SAFETY_ZERO_SUPPLY",
      reason: "supply is 0",
    };
  }
  const ppm = (amount * 1_000_000n) / supply;
  if (amount > 0n && ppm === 0n)
    return { status: "verified", percent: "<0.0001" };
  return {
    status: "verified",
    percent: `${ppm / 10000n}.${(ppm % 10000n).toString().padStart(4, "0")}`,
  };
}

/** Validates the largest-account rows against the mint and computes per-row and cumulative shares. */
export function buildHolderConcentration(args: {
  rows: readonly TokenAccountBalancePair[];
  slot: number;
  supply: bigint;
  supplySlot: number;
  decimals: number;
}): TokenSafetyChecks["holder_concentration"] {
  const { rows, slot, supply, supplySlot, decimals } = args;
  const inconsistent = (
    reason: string,
  ): TokenSafetyChecks["holder_concentration"] => ({
    status: "unknown",
    code: "TOKEN_SAFETY_HOLDER_ROWS_INCONSISTENT",
    reason,
    method: "getTokenLargestAccounts",
    slot,
    supplySlot,
  });

  const seen = new Set<string>();
  for (const row of rows) {
    const account = row.address.toBase58();
    if (!/^\d+$/.test(row.amount)) {
      return inconsistent(
        `token account ${account} reports amount "${row.amount}", which is not a non-negative integer of raw units; shares are unverified`,
      );
    }
    if (row.decimals !== decimals) {
      return inconsistent(
        `token account ${account} reports ${row.decimals} decimals but the mint has ${decimals}; shares are unverified`,
      );
    }
    if (seen.has(account)) {
      return inconsistent(
        `token account ${account} appears more than once in the response; shares are unverified`,
      );
    }
    seen.add(account);
  }
  if (supply > 0n && rows.length === 0) {
    return inconsistent(
      `the response lists no token accounts although the supply is ${supply} raw; shares are unverified`,
    );
  }
  const exceeds = (
    subject: string,
    amount: bigint,
  ): TokenSafetyChecks["holder_concentration"] => ({
    status: "unknown",
    code: "TOKEN_SAFETY_HOLDER_EXCEEDS_SUPPLY",
    reason:
      slot === supplySlot
        ? `${subject} ${amount} raw at slot ${slot}, above the supply of ${supply} raw read at the same slot; the RPC response is inconsistent, so shares are unverified`
        : `${subject} ${amount} raw at slot ${slot}, above the supply of ${supply} raw read at slot ${supplySlot}; supply changed between the two reads (mint or burn), so shares are unverified`,
    method: "getTokenLargestAccounts",
    slot,
    supplySlot,
  });
  let total = 0n;
  for (const row of rows) {
    const amount = BigInt(row.amount);
    if (amount > supply) {
      return exceeds(`token account ${row.address.toBase58()} shows`, amount);
    }
    total += amount;
  }
  // Rows that each fit under the supply can still sum above it (a mint or burn
  // between the two reads); a cumulative share above 100% is never verified.
  if (total > supply) {
    return exceeds(
      `the ${rows.length} returned token accounts together show`,
      total,
    );
  }

  let cumulative = 0n;
  let top10 = 0n;
  const holderRows: HolderRow[] = rows.map((row, i) => {
    const amount = BigInt(row.amount);
    cumulative += amount;
    if (i < 10) top10 = cumulative;
    return {
      rank: i + 1,
      tokenAccount: row.address.toBase58(),
      amountRaw: row.amount,
      amountUi: toHuman(amount, decimals),
      shareOfSupply: sharePercent(amount, supply),
      cumulativeShareOfSupply: sharePercent(cumulative, supply),
    };
  });
  return {
    status: "verified",
    method: "getTokenLargestAccounts",
    slot,
    supplySlot,
    rpcMaxRows: 20,
    rowsReturned: rows.length,
    label: "token_accounts_not_owners",
    rows: holderRows,
    top10ShareOfSupply: sharePercent(top10, supply),
    allReturnedShareOfSupply: sharePercent(cumulative, supply),
  };
}
