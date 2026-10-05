/**
 * Renders the complete model-facing `onchain_token_safety:` block. Every check
 * line, every extension, every returned holder row and every full base58
 * address is printed; nothing is sliced or capped. Wording avoids the
 * completion verbs and holding words that core egress checks for, and no
 * clause is a bare "<number> <word>" pair, so a reply quoting the block is not
 * read as a completed action or as an ungrounded holding claim. Free text that
 * can span lines (provider error bodies, echoed inputs) is escaped reversibly
 * onto its own line; the data keeps the raw value. When the mint carries a
 * display-multiplier extension (or the extension list is unreadable), every
 * decimal amount is labelled raw-decimal and a `ui_amounts:` line names the
 * extension whose multiplier those figures exclude.
 */
import {
  type ActiveFee,
  type ExtAddr,
  type ExtCheck,
  type FeeTier,
  type Share,
  TOKEN_SAFETY_CHECK_IDS,
  type TokenSafetyActionData,
  type TokenSafetyChecks,
  type TokenSafetyInvalidInput,
  type TokenSafetyReport,
  type UiMultiplierExtension,
  type Unknown,
} from "./types.js";

const INSTALLED_SPL_TOKEN = "@solana/spl-token 0.4.14";
const SPL_NO_EXTENSIONS = "SPL Token program mints cannot carry extensions";
const REPORT_NOTE =
  '"UNKNOWN means the check could not be performed; treat it as unverified, not as passed. flags are derived from verified checks only; no overall safe/unsafe verdict is computed. Describe concentration as share of supply; rows are token accounts, not owners."';

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Escapes backslashes, control characters and Unicode line separators so
 * free text (a complete provider error body, an echoed input) stays on its
 * own indented line. The mapping is reversible, so nothing is dropped; a raw
 * multi-line body could otherwise open a new line that reads as a bare
 * "<number> <word>" holding claim.
 */
function oneLine(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

function unknownInline(check: Unknown): string {
  return `UNKNOWN [${check.code}] — ${sentence(oneLine(check.reason))} Unverified, not passed`;
}

function unknownLine(check: Unknown): string {
  return `${unknownInline(check)}.`;
}

/** Appends the raw-decimal label to a decimal amount when a display multiplier may apply. */
type UiLabel = (decimal: string) => string;

const MULTIPLIER_TYPE: Readonly<Record<UiMultiplierExtension, number>> = {
  InterestBearingConfig: 10,
  ScaledUiAmountConfig: 25,
};

function uiLabel(report: TokenSafetyReport): UiLabel {
  const basis = report.uiAmounts;
  return basis.status === "verified" && basis.multiplierExtensions.length === 0
    ? (decimal) => decimal
    : (decimal) => `${decimal} raw-decimal`;
}

function maximum(
  tier: Pick<FeeTier, "maximumIsU64Max" | "maximumFeeUi" | "maximumFeeRaw">,
  ui: UiLabel,
): string {
  return tier.maximumIsU64Max
    ? "no cap (u64 max)"
    : `${ui(tier.maximumFeeUi)} (raw ${tier.maximumFeeRaw})`;
}

function addrOr(
  addr: ExtAddr,
  whenSet: (a: string) => string,
  whenUnset: string,
): string {
  return addr.state === "set" ? whenSet(addr.address) : whenUnset;
}

function activeFee(active: ActiveFee, ui: UiLabel): string {
  if (active.status === "unknown") {
    return `active fee ${unknownInline(active)}`;
  }
  if (active.basis === "tiers_identical") {
    return `active fee ${active.basisPoints} bps, maximum ${maximum(active, ui)}: both tiers are identical, so the current epoch does not change it`;
  }
  return `active fee at epoch ${active.currentEpoch}: ${active.tier} tier at ${active.basisPoints} bps, maximum ${maximum(active, ui)}`;
}

/**
 * States which tier applies next, independent of the fee config authority: a
 * newer tier that differs takes effect at its epoch with no further signature
 * even when that authority is unset.
 */
function feeSchedule(active: ActiveFee, newer: FeeTier): string | null {
  if (active.status === "unknown") {
    return `the newer tier applies from epoch ${newer.epoch} onward without any further signature, and whether that epoch has been reached is unverified`;
  }
  if (active.basis === "tiers_identical") return null;
  return active.tier === "older"
    ? `the newer tier takes effect at epoch ${newer.epoch} without any further signature`
    : "the older tier can no longer apply";
}

function shareText(share: Share): string {
  return share.status === "verified"
    ? `${share.percent}% of supply`
    : `share of supply UNKNOWN [${share.code}] (${oneLine(share.reason)})`;
}

function cumulativeText(share: Share): string {
  return share.status === "verified"
    ? `${share.percent}%`
    : `share of supply UNKNOWN [${share.code}] (${oneLine(share.reason)})`;
}

/** Renders the absent/unknown branches of an extension check as a line, or returns the verified-present check. */
function extensionState<C>(
  check: ExtCheck<C>,
  name: string,
): string | ({ status: "verified"; present: true } & C) {
  if (check.status === "unknown") return unknownLine(check);
  if (check.present === false) {
    return check.basis === "tlv_scanned"
      ? `verified — ${name} absent (TLV scanned)`
      : `verified — absent: ${SPL_NO_EXTENSIONS}`;
  }
  return check;
}

function checkLines(
  id: (typeof TOKEN_SAFETY_CHECK_IDS)[number],
  checks: TokenSafetyChecks,
  ui: UiLabel,
): string[] {
  switch (id) {
    case "token_program": {
      const c = checks.token_program;
      return [
        `verified — ${c.program === "token-2022" ? "Token-2022" : "SPL Token"} (${c.programId})`,
      ];
    }
    case "supply": {
      const c = checks.supply;
      const native = c.nativeMint
        ? "; this is the native wrapped-SOL mint, whose supply field does not count wrapped SOL"
        : "";
      return [
        `verified — ${ui(c.ui)} (raw ${c.raw}, decimals ${c.decimals})${native}`,
      ];
    }
    case "mint_authority": {
      const c = checks.mint_authority;
      return [
        c.state === "present"
          ? `verified — PRESENT ${c.address}: this account can mint new supply`
          : "verified — REVOKED",
      ];
    }
    case "freeze_authority": {
      const c = checks.freeze_authority;
      return [
        c.state === "present"
          ? `verified — PRESENT ${c.address}: this account can freeze any token account of this mint`
          : "verified — REVOKED",
      ];
    }
    case "transfer_hook": {
      const c = extensionState(checks.transfer_hook, "TransferHook");
      if (typeof c === "string") return [c];
      const program = addrOr(
        c.hookProgram,
        (a) => `hook program ${a} runs on every token movement`,
        "hook program NOT SET (no hook runs)",
      );
      const authority =
        c.authority.state === "set"
          ? c.hookProgram.state === "set"
            ? `hook authority ${c.authority.address} can replace it`
            : `hook authority ${c.authority.address} can set one later`
          : "hook authority NOT SET (the hook program cannot be changed)";
      return [`verified — TransferHook PRESENT; ${program}; ${authority}`];
    }
    case "transfer_fee": {
      const c = extensionState(checks.transfer_fee, "TransferFeeConfig");
      if (typeof c === "string") return [c];
      const tier = (label: string, t: FeeTier) =>
        `${label} tier from epoch ${t.epoch}: ${t.basisPoints} bps, maximum ${maximum(t, ui)}`;
      const schedule = feeSchedule(c.active, c.newer);
      const configAuthority = addrOr(
        c.transferFeeConfigAuthority,
        (a) => `fee config authority ${a} can schedule a new fee`,
        "fee config authority NOT SET (no new fee can be scheduled)",
      );
      const withdrawAuthority = addrOr(
        c.withdrawWithheldAuthority,
        (a) => `withdraw-withheld authority ${a} can withdraw withheld fees`,
        "withdraw-withheld authority NOT SET",
      );
      return [
        [
          "verified — TransferFeeConfig PRESENT",
          tier("older", c.older),
          tier("newer", c.newer),
          activeFee(c.active, ui),
          ...(schedule === null ? [] : [schedule]),
          configAuthority,
          withdrawAuthority,
          `withheld on mint ${ui(c.withheldAmountUi)} (raw ${c.withheldAmountRaw})`,
        ].join("; "),
      ];
    }
    case "permanent_delegate": {
      const c = extensionState(checks.permanent_delegate, "PermanentDelegate");
      if (typeof c === "string") return [c];
      return [
        addrOr(
          c.delegate,
          (a) =>
            `verified — PermanentDelegate PRESENT ${a}: this account can move or burn tokens from any token account of this mint`,
          "verified — PermanentDelegate PRESENT; delegate NOT SET (no account has this power)",
        ),
      ];
    }
    case "non_transferable": {
      const c = extensionState(checks.non_transferable, "NonTransferable");
      if (typeof c === "string") return [c];
      return [
        "verified — NonTransferable PRESENT: tokens of this mint cannot move between owners",
      ];
    }
    case "default_account_state": {
      const c = extensionState(
        checks.default_account_state,
        "DefaultAccountState",
      );
      if (typeof c === "string") return [c];
      if (!c.frozenByDefault) {
        return [
          "verified — DefaultAccountState PRESENT: new token accounts start initialized (not frozen)",
        ];
      }
      const freeze = checks.freeze_authority;
      const thaw =
        freeze.state === "present"
          ? `freeze authority ${freeze.address} can thaw them`
          : "freeze authority is REVOKED, so new accounts cannot be thawed";
      return [
        `verified — DefaultAccountState PRESENT: new token accounts start FROZEN (${thaw})`,
      ];
    }
    case "mint_close_authority": {
      const c = extensionState(
        checks.mint_close_authority,
        "MintCloseAuthority",
      );
      if (typeof c === "string") return [c];
      return [
        addrOr(
          c.closeAuthority,
          (a) =>
            `verified — MintCloseAuthority PRESENT ${a}: can close the mint account once supply is 0`,
          "verified — MintCloseAuthority PRESENT; close authority NOT SET (the mint account cannot be closed)",
        ),
      ];
    }
    case "pausable": {
      const c = extensionState(checks.pausable, "PausableConfig");
      if (typeof c === "string") return [c];
      const authority = addrOr(
        c.authority,
        (a) => `pause authority ${a}`,
        "pause authority NOT SET",
      );
      return [
        `verified — PausableConfig PRESENT; ${c.paused ? "PAUSED" : "NOT PAUSED"}; ${authority}`,
      ];
    }
    case "other_extensions": {
      const c = checks.other_extensions;
      if (c.status === "unknown") return [unknownLine(c)];
      if (c.basis === "spl_token_program_has_no_extensions") {
        return [`verified — none: ${SPL_NO_EXTENSIONS}`];
      }
      if (c.entries.length === 0) {
        return ["verified — none beyond the decoded checks (TLV scanned)"];
      }
      const items = c.entries.map((entry) => {
        const notes = [`type ${entry.type}`];
        if (entry.scope === "account_extension_in_mint_data") {
          notes.push("an account-level extension stored in mint data");
        }
        if (!entry.decodableByInstalledSplToken) {
          notes.push(`not decodable by the installed ${INSTALLED_SPL_TOKEN}`);
        }
        return `${entry.name} (${notes.join("; ")})`;
      });
      return [
        `verified — ${c.entries.length} present, listed by name, configuration not assessed: ${items.join(", ")}`,
      ];
    }
    case "holder_concentration": {
      const c = checks.holder_concentration;
      if (c.status === "unknown") return [unknownLine(c)];
      const accounts =
        c.rowsReturned === 1
          ? "1 token account"
          : `${c.rowsReturned} token accounts`;
      const head = `verified — getTokenLargestAccounts at slot ${c.slot} returned ${accounts} (the RPC returns at most ${c.rpcMaxRows}). These are token ACCOUNTS, not owners: one owner can control several accounts, and an account can be a pool, exchange or program vault. Shares use the supply read at slot ${c.supplySlot}, rounded down to 4 decimal places. Top 10: ${shareText(c.top10ShareOfSupply)}; all ${c.rowsReturned} returned: ${shareText(c.allReturnedShareOfSupply)}.`;
      const rows = c.rows.map(
        (row) =>
          `  #${row.rank} ${row.tokenAccount} amount ${ui(row.amountUi)} (raw ${row.amountRaw}): ${shareText(row.shareOfSupply)}, cumulative ${cumulativeText(row.cumulativeShareOfSupply)}`,
      );
      return [head, ...rows];
    }
    default:
      return id satisfies never;
  }
}

function extensionsLine(report: TokenSafetyReport): string {
  const inv = report.extensionInventory;
  if (inv.status === "unknown") return unknownLine(inv);
  if (inv.entries.length === 0) {
    return report.checks.token_program.program === "spl-token"
      ? "none (SPL Token program)"
      : "none (TLV scanned)";
  }
  return `${inv.entries.length} present in account order: ${inv.entries
    .map((entry) => `${entry.name} (${entry.type})`)
    .join(", ")}`;
}

/** Names the display multiplier the decimal amounts exclude, or null when none applies. */
function uiAmountsLine(report: TokenSafetyReport): string | null {
  const basis = report.uiAmounts;
  const derivation =
    "decimal amounts in this report are raw-decimal (raw / 10^decimals)";
  if (basis.status === "unknown") {
    return `${derivation}; a display multiplier is ${unknownLine(basis)}`;
  }
  if (basis.multiplierExtensions.length === 0) return null;
  const names = basis.multiplierExtensions
    .map((name) => `${name} (type ${MULTIPLIER_TYPE[name]})`)
    .join(" and ");
  return `${derivation} and exclude the display multiplier of ${names}, which is not decoded; apps that apply the multiplier show different figures. Shares of supply are ratios, so the multiplier does not change them.`;
}

/** Renders the complete report block with one line per check and every holder row. */
export function formatTokenSafetyReport(report: TokenSafetyReport): string {
  const { coverage } = report;
  const ui = uiLabel(report);
  const lines = [
    "onchain_token_safety:",
    "  status: report",
    `  mint: ${report.mint}`,
    `  source: Solana RPC from SOLANA_RPC_URL; mint account read at slot ${report.source.mintSlot}`,
    `  coverage: ${coverage.checksFullyVerified} of ${coverage.checksTotal} checks fully verified; unknown: ${
      coverage.unknown.length === 0 ? "none" : coverage.unknown.join(", ")
    }`,
    "  checks:",
  ];
  for (const id of TOKEN_SAFETY_CHECK_IDS) {
    const [first, ...rest] = checkLines(id, report.checks, ui);
    lines.push(`    ${id}: ${first}`);
    for (const extra of rest) lines.push(`    ${extra}`);
  }
  lines.push(`  extensions: ${extensionsLine(report)}`);
  const uiAmounts = uiAmountsLine(report);
  if (uiAmounts !== null) lines.push(`  ui_amounts: ${uiAmounts}`);
  lines.push(
    `  flags: ${report.flags.length === 0 ? "none" : report.flags.join(", ")}`,
  );
  lines.push(`  note: ${REPORT_NOTE}`);
  return lines.join("\n");
}

/** Renders an invalid-input result; the source line appears only when an account was read. */
export function formatTokenSafetyInvalid(
  invalid: TokenSafetyInvalidInput,
): string {
  const lines = [
    "onchain_token_safety:",
    "  status: invalid_input",
    `  error: ${invalid.error}`,
    `  kind: ${invalid.kind}`,
    `  input: ${invalid.input === null ? "(none)" : oneLine(invalid.input)}`,
    `  detail: ${oneLine(invalid.detail)}`,
  ];
  if (invalid.slot !== null) {
    lines.push(
      `  source: Solana RPC from SOLANA_RPC_URL; account read at slot ${invalid.slot}`,
    );
  }
  lines.push(
    '  note: "No token safety check was performed for this input. Nothing about any token is verified."',
  );
  return lines.join("\n");
}

/** Renders a typed RPC or configuration failure; the endpoint value never appears. */
export function formatTokenSafetyRpcFailure(
  data: Extract<TokenSafetyActionData, { outcome: "rpc_failure" }>,
): string {
  const { failure } = data;
  const note =
    failure.method === "getAccountInfo" || failure.method === "configuration"
      ? "The mint account could not be read, so no check was performed. Nothing about this token is verified."
      : `The ${failure.method} read failed unexpectedly, so no report was produced. Nothing about this token is verified.`;
  return [
    "onchain_token_safety:",
    "  status: rpc_failure",
    `  error: ${data.error}`,
    `  code: ${failure.code}`,
    `  mint: ${data.mint === null ? "(none)" : data.mint}`,
    `  method: ${failure.method}`,
    `  detail: ${oneLine(failure.detail)}`,
    `  note: "${note}"`,
  ].join("\n");
}
