/**
 * Transport-level DTO types shared between the wallet HTTP routes and their
 * consumers: export request/rejection shapes, the market-overview response
 * (price snapshots, movers, Polymarket predictions) served by
 * `wallet-market-overview-route.ts`, the read-only crypto terminal market
 * list and price history served by `wallet-terminal-market-route.ts`, the
 * Solana token safety report served by `wallet-terminal-token-safety-route.ts`,
 * and the terminal's reviewed real trades served by `api/terminal-trade.ts`.
 */
import type { TradePermissionMode } from "@elizaos/shared";

export interface WalletExportRequestBody {
  confirm?: boolean;
  exportToken?: string;
}

export interface WalletExportRejection {
  status: 400 | 401 | 402 | 403 | 429;
  reason: string;
}

export interface WalletMarketPriceSnapshot {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  imageUrl: string | null;
}

export interface WalletMarketMover {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
}

export interface WalletMarketPrediction {
  id: string;
  slug: string | null;
  question: string;
  highlightedOutcomeLabel: string;
  highlightedOutcomeProbability: number | null;
  volume24hUsd: number;
  totalVolumeUsd: number | null;
  endsAt: string | null;
  imageUrl: string | null;
}

export type WalletMarketOverviewProviderId =
  | "coingecko"
  | "coinpaprika"
  | "polymarket";

export interface WalletMarketOverviewSource {
  providerId: WalletMarketOverviewProviderId;
  providerName: string;
  providerUrl: string;
  available: boolean;
  stale: boolean;
  error: string | null;
}

export interface WalletMarketOverviewResponse {
  generatedAt: string;
  cacheTtlSeconds: number;
  stale: boolean;
  sources: {
    prices: WalletMarketOverviewSource;
    movers: WalletMarketOverviewSource;
    predictions: WalletMarketOverviewSource;
  };
  prices: WalletMarketPriceSnapshot[];
  movers: WalletMarketMover[];
  predictions: WalletMarketPrediction[];
}

/** One row of the crypto terminal market list (CoinGecko top market cap). */
export interface WalletTerminalMarket {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
}

/** Response from GET /api/wallet/terminal/markets. */
export interface WalletTerminalMarketsResponse {
  generatedAt: string;
  stale: boolean;
  source: WalletMarketOverviewSource;
  markets: WalletTerminalMarket[];
}

/** Price-history windows the terminal chart supports, in days. */
export type WalletTerminalChartDays = 1 | 7 | 30 | 90 | 365;

/** One USD price observation; `t` is epoch milliseconds. */
export interface WalletTerminalChartPoint {
  t: number;
  priceUsd: number;
}

/** Response from GET /api/wallet/terminal/chart. */
export interface WalletTerminalChartResponse {
  id: string;
  days: WalletTerminalChartDays;
  generatedAt: string;
  stale: boolean;
  source: WalletMarketOverviewSource;
  points: WalletTerminalChartPoint[];
}

/** Where a token safety report came from and whether it is current. */
export interface WalletTokenSafetySource {
  providerId: "goplus";
  providerName: string;
  providerUrl: string;
  available: boolean;
  stale: boolean;
  error: string | null;
}

/**
 * One check's outcome. `danger` is a power that can take or lock holder funds,
 * `warn` is a risk worth weighing, `unknown` means the provider did not report
 * the field, and `ok` means the provider reported it as absent.
 */
export type WalletTokenSafetySeverity = "danger" | "warn" | "unknown" | "ok";

/** Overall reading: any danger → avoid; any warn or unknown → caution. */
export type WalletTokenSafetyVerdict = "avoid" | "caution" | "no-major-flags";

export interface WalletTokenSafetyCheck {
  id: string;
  label: string;
  severity: WalletTokenSafetySeverity;
  detail: string;
}

/** Response from GET /api/wallet/terminal/token-safety. */
export interface WalletTerminalTokenSafetyResponse {
  mint: string;
  name: string | null;
  symbol: string | null;
  generatedAt: string;
  stale: boolean;
  source: WalletTokenSafetySource;
  verdict: WalletTokenSafetyVerdict;
  checks: WalletTokenSafetyCheck[];
  holderCount: number | null;
  /** Share of supply held by the ten largest holders, as a percentage. */
  top10HolderPct: number | null;
  /** Sum of reported pool TVL across DEXes, in USD. */
  liquidityUsd: number | null;
  /** GoPlus marks a small set of well-known tokens as trusted. */
  trustedToken: boolean;
}

/** Provider behind a social signal, and whether this answer is fresh. */
export interface WalletSocialSignalSource {
  providerId: "lunarcrush";
  providerName: "LunarCrush";
  providerUrl: string;
  /** True when a refresh failed and an earlier answer is served instead. */
  stale: boolean;
  error: string | null;
}

/** LunarCrush's numbers for one tracked coin; null means it didn't report one. */
export interface WalletSocialSignalScores {
  /** LunarCrush's id, name and symbol for the coin it matched. */
  coin: { id: number | null; name: string | null; symbol: string | null };
  /** 0 to 100 blend of social and market activity; higher is stronger. */
  galaxyScore: number | null;
  /** Rank against every coin LunarCrush tracks; 1 is the strongest. */
  altRank: number | null;
  /** Share of social posts that read as positive, 0 to 100. */
  sentimentPct: number | null;
  socialVolume24h: number | null;
  interactions24h: number | null;
  /**
   * True when the Galaxy Score is reported and below the caution line. It can
   * only add caution beside the GoPlus verdict; it never clears or replaces it.
   */
  addsCaution: boolean;
}

/**
 * Response from GET /api/wallet/terminal/social and the WALLET
 * `social_signal` result. A read-only social signal that never changes the
 * GoPlus verdict: `no-key` means LUNARCRUSH_API_KEY is unset and nothing was
 * requested; `not-tracked` means LunarCrush has no coin for the symbol, which
 * is not a low score.
 */
export type WalletTerminalSocialSignalResponse =
  | { status: "no-key"; symbol: string }
  | {
      status: "not-tracked";
      symbol: string;
      checkedAt: string;
      stale: boolean;
      source: WalletSocialSignalSource;
    }
  | ({
      status: "tracked";
      symbol: string;
      checkedAt: string;
      stale: boolean;
      source: WalletSocialSignalSource;
    } & WalletSocialSignalScores);

/** Where the terminal's liquidity numbers come from. */
export interface WalletTokenPairsSource {
  providerId: "dexscreener";
  providerName: "DexScreener";
  providerUrl: string;
  /** True when a refresh failed and an earlier answer is served instead. */
  stale: boolean;
  error: string | null;
}

/** One trading pair for a mint; null means DexScreener didn't report it. */
export interface WalletTokenPair {
  pairAddress: string;
  /** The DEX the pool is on, such as `raydium` or `meteora`. */
  dexId: string | null;
  /** DexScreener's page for the pair. */
  url: string | null;
  baseSymbol: string | null;
  baseName: string | null;
  baseAddress: string | null;
  quoteSymbol: string | null;
  /** Price of the base token in USD, as DexScreener's decimal string. */
  priceUsd: string | null;
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** Fully diluted valuation in USD. */
  fdvUsd: number | null;
  /** ISO time the pool was created. */
  pairCreatedAt: string | null;
}

/**
 * Response from GET /api/wallet/terminal/pairs and the WALLET `token_pairs`
 * result. Read-only liquidity context that never changes the GoPlus verdict:
 * `no-pairs` means DexScreener knows no pool for the mint, which is not a zero
 * price and not a safe token.
 */
export type WalletTerminalTokenPairsResponse =
  | {
      status: "no-pairs";
      mint: string;
      checkedAt: string;
      stale: boolean;
      source: WalletTokenPairsSource;
    }
  | {
      status: "found";
      mint: string;
      checkedAt: string;
      stale: boolean;
      source: WalletTokenPairsSource;
      /** Every pair DexScreener reported, deepest liquidity first. */
      pairs: WalletTokenPair[];
      /** How many pairs DexScreener reported. */
      pairCount: number;
      totalLiquidityUsd: number;
      totalVolume24hUsd: number;
      /** ISO time the earliest pool was created. */
      oldestPairCreatedAt: string | null;
      thinLiquidity: boolean;
      newPool: boolean;
      /** True when no pool reports a creation time, so none can be aged. */
      poolAgeUnknown: boolean;
      /**
       * True when thin liquidity, a new pool or an unknown pool age warrants a caution beside the
       * GoPlus verdict. It never clears or replaces that verdict.
       */
      addsCaution: boolean;
    };

/** Exchanges the terminal places spot limit orders on with the agent's API keys. */
export type WalletExchangeVenue = "kraken" | "okx";
export type WalletExchangeBase = "SOL" | "USDC" | "USDT" | "PYUSD";
export type WalletExchangeQuote = "USD" | "USDT" | "USDC";

/** Response from GET /api/wallet/terminal/exchange/status. Never returns keys. */
export interface WalletTerminalExchangeStatusResponse {
  tradePermissionMode: TradePermissionMode;
  /** True when the permission mode lets a person place real orders. */
  realTradingEnabled: boolean;
  /** Each venue, and the settings it still needs before it can be used. */
  venues: Record<
    WalletExchangeVenue,
    { configured: boolean; missingSettings: string[] }
  >;
  bases: WalletExchangeBase[];
  quotes: WalletExchangeQuote[];
  /** Largest order value allowed, in the quote currency (USD or a USD stablecoin). */
  maxOrderUsd: number;
  /** How long a review can be confirmed, in seconds. */
  reviewSeconds: number;
}

/** Body of POST /api/wallet/terminal/exchange/review. */
export interface WalletTerminalExchangeReviewRequest {
  venue: WalletExchangeVenue;
  base: WalletExchangeBase;
  quote: WalletExchangeQuote;
  side: WalletTerminalTradeSide;
  /** Base currency amount, as a decimal string. */
  quantity: string;
  /** Limit price in the quote currency, as a decimal string. */
  price: string;
}

/** One thing the venue confirmed about the order before it can be placed. */
export interface WalletExchangeReviewCheck {
  label: string;
  detail: string;
}

/** Response from POST /api/wallet/terminal/exchange/review. */
export interface WalletTerminalExchangeReview {
  reviewId: string;
  /** ISO time after which the review can no longer be confirmed. */
  expiresAt: string;
  venue: WalletExchangeVenue;
  /** The venue's own market name, such as `SOLUSD` or `SOL-USD`. */
  market: string;
  base: WalletExchangeBase;
  quote: WalletExchangeQuote;
  side: WalletTerminalTradeSide;
  orderType: "limit";
  quantity: string;
  price: string;
  /** quantity × price, in the quote currency. */
  orderValue: string;
  /** What the venue confirmed: validation, market rules, and available funds. */
  checks: WalletExchangeReviewCheck[];
  /** The id the venue will see on this order, so it can be found if a send is lost. */
  clientOrderId: string;
}

/** Body of POST /api/wallet/terminal/exchange/execute. */
export interface WalletTerminalExchangeExecuteRequest {
  reviewId: string;
  confirm: true;
}

/** Where an exchange order the terminal placed stands, as last seen. */
export type WalletExchangeOrderState =
  | "submitted"
  | "open"
  | "partially-filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "unknown";

/**
 * An exchange order placed from the terminal. `unknown` means the send's
 * outcome was not seen; check the venue before placing another order.
 */
export interface WalletExchangeOrder {
  clientOrderId: string;
  /** The venue's order id, once it has reported one. */
  orderId: string | null;
  venue: WalletExchangeVenue;
  market: string;
  side: WalletTerminalTradeSide;
  quantity: string;
  price: string;
  state: WalletExchangeOrderState;
  /** Base amount filled so far, when the venue reported it. */
  filledQuantity: string | null;
  detail: string;
  placedAt: string;
  checkedAt: string;
}

/** Response from GET /api/wallet/terminal/exchange/orders, newest first. */
export interface WalletTerminalExchangeOrdersResponse {
  orders: WalletExchangeOrder[];
}

/** A terminal real trade spends SOL for a token (buy) or the reverse (sell). */
export type WalletTerminalTradeSide = "buy" | "sell";

/**
 * How a terminal trade is sent: `rpc` submits it through the configured Solana
 * RPC with a capped priority fee; `jito` adds a Jito tip and sends it only to a
 * Jito block engine as a bundle, so it is never broadcast to the public mempool.
 */
export type WalletTerminalTradeSendRoute = "rpc" | "jito";

/** Whether this wallet can sign Solana trades for the terminal. */
export type WalletTerminalTradeWallet =
  | { canSign: true; address: string }
  | { canSign: false; address: string | null; reason: string };

/** Response from GET /api/wallet/terminal/trade/status. */
export interface WalletTerminalTradeStatusResponse {
  tradePermissionMode: TradePermissionMode;
  /** True when the permission mode lets a person trade with the local wallet. */
  realTradingEnabled: boolean;
  wallet: WalletTerminalTradeWallet;
  /** Largest buy allowed in one trade, in SOL. */
  maxBuySol: number;
  slippageChoicesBps: number[];
  /** How long a review can be confirmed, in seconds. */
  reviewSeconds: number;
  /** The tip and block engine a `jito` send uses. */
  jito: {
    tipLamports: number;
    blockEngineUrl: string;
    /** Regions tried in order when the first engine is unreachable or busy. */
    backupBlockEngineUrls: string[];
  };
}

/** Body of POST /api/wallet/terminal/trade/review. */
export interface WalletTerminalTradeReviewRequest {
  side: WalletTerminalTradeSide;
  mint: string;
  /** SOL to spend for a buy, or token units to sell, as a decimal string. */
  amount: string;
  slippageBps: number;
  sendRoute: WalletTerminalTradeSendRoute;
}

/** One side of a reviewed swap, in display units and base units. */
export interface WalletTerminalTradeAmount {
  mint: string;
  /** "SOL" for native SOL, otherwise null (the terminal shows the mint). */
  symbol: "SOL" | null;
  decimals: number;
  amount: string;
  rawAmount: string;
}

/** One leg of the route the reviewed transaction takes. */
export interface WalletTerminalTradeRouteLeg {
  label: string | null;
  inputMint: string;
  outputMint: string;
  percent: number | null;
}

/** Simulation of the exact transaction under review. */
export interface WalletTerminalTradeSimulation {
  success: boolean;
  err: string | null;
  logs: string[];
  unitsConsumed: number | null;
}

/** Response from POST /api/wallet/terminal/trade/review. */
export interface WalletTerminalTradeReview {
  reviewId: string;
  /** ISO time after which the review can no longer be confirmed. */
  expiresAt: string;
  chain: "solana";
  side: WalletTerminalTradeSide;
  /** The wallet that signs and receives the output. */
  walletAddress: string;
  input: WalletTerminalTradeAmount;
  /** Quoted output. */
  output: WalletTerminalTradeAmount;
  /** Least output the transaction accepts, in display units. */
  minimumOutput: string;
  slippageBps: number;
  priceImpactPct: string | null;
  route: WalletTerminalTradeRouteLeg[];
  /** Fees beyond the swap itself; the second one depends on the send route. */
  fee:
    | {
        route: "rpc";
        baseFeeLamports: number;
        /** Priority fee the swap set, when Jupiter reported it. */
        priorityFeeLamports: number | null;
        maxPriorityFeeLamports: number;
      }
    | { route: "jito"; baseFeeLamports: number; jitoTipLamports: number };
  /** Where the signed transaction goes on confirm. */
  sending:
    | { route: "rpc"; detail: string }
    | {
        route: "jito";
        blockEngineUrl: string;
        backupBlockEngineUrls: string[];
        detail: string;
      };
  simulation: WalletTerminalTradeSimulation;
  /** False when the simulation failed; such a review cannot be confirmed. */
  canConfirm: boolean;
}

/** Body of POST /api/wallet/terminal/trade/execute. */
export interface WalletTerminalTradeExecuteRequest {
  reviewId: string;
  confirm: true;
}

/**
 * Response from POST /api/wallet/terminal/trade/execute. `failed` means the
 * transaction landed and reverted; `unconfirmed` means it was sent but its
 * outcome was not seen before the blockhash expired or the RPC gave up.
 */
export type WalletTerminalTradeExecuteResponse =
  | { status: "confirmed"; signature: string; explorerUrl: string }
  | { status: "failed"; signature: string; explorerUrl: string; error: string }
  | {
      status: "unconfirmed";
      signature: string;
      explorerUrl: string;
      detail: string;
    };
