/**
 * Test support for token_safety: a deterministic loopback node:http JSON-RPC
 * server that the real @solana/web3.js Connection talks to, byte-exact mint
 * account encoders built from the installed spl-token layouts, and a plain
 * runtime object that records settings reads, service lookups and log calls.
 *
 * Not a test file: it is not collected by vitest and is excluded from the
 * package tsconfig. Every request is recorded, and any write-shaped method
 * (send*, simulate*, request*) is refused with -32601 so a test can prove the
 * inspection stays read-only.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import {
  ACCOUNT_SIZE,
  AccountType,
  DefaultAccountStateLayout,
  MintCloseAuthorityLayout,
  MintLayout,
  MULTISIG_SIZE,
  PausableConfigLayout,
  PermanentDelegateLayout,
  type TransferFeeConfig,
  TransferFeeConfigLayout,
  TransferHookLayout,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

export type Reply =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { httpStatus: number; body: string }
  | { stall: true };
export type Handlers = Partial<
  Record<string, Reply | ((params: unknown[]) => Reply)>
>;
export type RecordedRequest = { method: string; params: unknown[] };
export type SolanaRpcFixture = {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

/** Starts the loopback JSON-RPC server on 127.0.0.1 with an ephemeral port. */
export async function startSolanaRpcFixture(
  handlers: Handlers,
): Promise<SolanaRpcFixture> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { id?: unknown; method?: unknown; params?: unknown })
          : {};
      const method = typeof call.method === "string" ? call.method : "";
      const params = Array.isArray(call.params) ? call.params : [];
      requests.push({ method, params });
      const writeShaped = /^(?:send|simulate|request)/.test(method);
      const handler = writeShaped ? undefined : handlers[method];
      const reply: Reply =
        handler === undefined
          ? { error: { code: -32601, message: `Method not found: ${method}` } }
          : typeof handler === "function"
            ? handler(params)
            : handler;
      if ("stall" in reply) return;
      if ("httpStatus" in reply) {
        res.writeHead(reply.httpStatus, { "content-type": "text/plain" });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          "result" in reply
            ? { jsonrpc: "2.0", id: call.id, result: reply.result }
            : { jsonrpc: "2.0", id: call.id, error: reply.error },
        ),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type TlvExtension = { type: number; data: Buffer };

function encodeWith<T>(
  layout: { span: number; encode: (src: T, b: Uint8Array) => number },
  value: T,
): Buffer {
  const buf = Buffer.alloc(layout.span);
  layout.encode(value, buf);
  return buf;
}

/** Layout-encoded extension payloads for the seven decoded risk types. */
export const ext = {
  transferFeeConfig: (cfg: TransferFeeConfig): TlvExtension => ({
    type: 1,
    data: encodeWith(TransferFeeConfigLayout, cfg),
  }),
  mintCloseAuthority: (closeAuthority: PublicKey): TlvExtension => ({
    type: 3,
    data: encodeWith(MintCloseAuthorityLayout, { closeAuthority }),
  }),
  defaultAccountState: (state: number): TlvExtension => ({
    type: 6,
    data: encodeWith(DefaultAccountStateLayout, { state }),
  }),
  nonTransferable: (): TlvExtension => ({ type: 9, data: Buffer.alloc(0) }),
  permanentDelegate: (delegate: PublicKey): TlvExtension => ({
    type: 12,
    data: encodeWith(PermanentDelegateLayout, { delegate }),
  }),
  transferHook: (authority: PublicKey, programId: PublicKey): TlvExtension => ({
    type: 14,
    data: encodeWith(TransferHookLayout, { authority, programId }),
  }),
  pausable: (authority: PublicKey, paused: boolean): TlvExtension => ({
    type: 26,
    data: encodeWith(PausableConfigLayout, { authority, paused }),
  }),
  opaque: (type: number, length: number): TlvExtension => ({
    type,
    data: Buffer.alloc(length, 7),
  }),
};

/** Serializes TLV entries as u16 type, u16 length, then the payload. */
export function encodeTlv(entries: readonly TlvExtension[]): Buffer {
  return Buffer.concat(
    entries.map((entry) => {
      const header = Buffer.alloc(4);
      header.writeUInt16LE(entry.type, 0);
      header.writeUInt16LE(entry.data.length, 2);
      return Buffer.concat([header, entry.data]);
    }),
  );
}

export type MintFixtureOptions = {
  mintAuthority?: PublicKey | null;
  freezeAuthority?: PublicKey | null;
  supply?: bigint;
  decimals?: number;
  isInitialized?: boolean;
  extensions?: readonly TlvExtension[];
  rawTlv?: Buffer;
  trailingPadding?: number;
  optionTagOverride?: { mint?: number; freeze?: number };
  dataOverride?: Buffer;
};

/**
 * Builds mint account bytes: 82 bytes without TLV, otherwise the Token-2022
 * layout (base, padding to 165, AccountType.Mint, TLV). Like spl-token
 * `getMintLen`, a length that would equal the multisig size gains 2 bytes.
 */
export function encodeMintAccount(opts: MintFixtureOptions = {}): Buffer {
  if (opts.dataOverride) return opts.dataOverride;
  const tlv = opts.rawTlv ?? encodeTlv(opts.extensions ?? []);
  const base = Buffer.alloc(82);
  const mintAuthority = opts.mintAuthority ?? null;
  const freezeAuthority = opts.freezeAuthority ?? null;
  MintLayout.encode(
    {
      mintAuthorityOption: mintAuthority ? 1 : 0,
      mintAuthority: mintAuthority ?? PublicKey.default,
      supply: opts.supply ?? 0n,
      decimals: opts.decimals ?? 0,
      isInitialized: opts.isInitialized ?? true,
      freezeAuthorityOption: freezeAuthority ? 1 : 0,
      freezeAuthority: freezeAuthority ?? PublicKey.default,
    },
    base,
  );
  if (opts.optionTagOverride?.mint !== undefined) {
    base.writeUInt32LE(opts.optionTagOverride.mint, 0);
  }
  if (opts.optionTagOverride?.freeze !== undefined) {
    base.writeUInt32LE(opts.optionTagOverride.freeze, 46);
  }
  const padding = Buffer.alloc(opts.trailingPadding ?? 0);
  if (tlv.length === 0 && padding.length === 0) return base;
  let length = ACCOUNT_SIZE + 1 + tlv.length;
  if (length === MULTISIG_SIZE) length += 2;
  const out = Buffer.alloc(length + padding.length);
  base.copy(out, 0);
  out[ACCOUNT_SIZE] = AccountType.Mint;
  tlv.copy(out, ACCOUNT_SIZE + 1);
  return out;
}

/** getAccountInfo(AndContext) result for the given bytes and owner. */
export function accountInfoResult(
  bytes: Buffer,
  owner: string,
  slot: number,
): unknown {
  return {
    context: { slot },
    value: {
      data: [bytes.toString("base64"), "base64"],
      owner,
      lamports: 1,
      executable: false,
      rentEpoch: 0,
      space: bytes.length,
    },
  };
}

/** getTokenLargestAccounts result rows. */
export function largestAccountsResult(
  rows: ReadonlyArray<{ address: string; amount: string; decimals: number }>,
  slot: number,
): unknown {
  return {
    context: { slot },
    value: rows.map((row) => ({
      address: row.address,
      amount: row.amount,
      decimals: row.decimals,
      uiAmount: null,
      uiAmountString: row.amount,
    })),
  };
}

/** getEpochInfo result at the given epoch. */
export function epochInfoResult(epoch: number): unknown {
  return {
    absoluteSlot: 1000,
    blockHeight: 900,
    epoch,
    slotIndex: 10,
    slotsInEpoch: 432000,
    transactionCount: 123,
  };
}

export type LogEntry = { level: string; args: unknown[] };
export type PlainRuntime = {
  getSetting: (key: string) => string | null;
  getService: (name: string) => null;
  logger: {
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  serviceCalls: string[];
  logs: LogEntry[];
};

/** A plain runtime object: settings from a record, no services, recorded log calls. */
export function plainRuntime(
  settings: Record<string, string | undefined>,
): PlainRuntime {
  const serviceCalls: string[] = [];
  const logs: LogEntry[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push({ level, args });
    };
  return {
    getSetting: (key) => settings[key] ?? null,
    getService: (name) => {
      serviceCalls.push(name);
      return null;
    },
    logger: {
      warn: record("warn"),
      info: record("info"),
      debug: record("debug"),
      error: record("error"),
    },
    serviceCalls,
    logs,
  };
}

/**
 * Presents a plain runtime to code typed against IAgentRuntime. The code under
 * test touches only getSetting, getService and logger.warn/info/debug/error,
 * all of which the plain object implements.
 */
export function asAgentRuntime(runtime: PlainRuntime): IAgentRuntime {
  return runtime as unknown as IAgentRuntime;
}
