# @elizaos/plugin-wallet

Non-custodial wallet for elizaOS agents: EVM + Solana signing, x402 micropayments, CCTP bridge, Li.Fi swap/bridge routing, Jupiter routing, multi-DEX LP management, on-chain spend policies, analytics (Birdeye, DexScreener, token info), and the wallet inventory UI surface (shell page, standalone view, chat-sidebar widget).

## Purpose / role

Adds a unified wallet action+provider surface to an Eliza agent, replacing the previous fan-out across `plugin-evm`, `plugin-solana`, `plugin-raydium`, `plugin-orca`, `plugin-meteora`, `plugin-jupiter`, `plugin-lp-manager`, and `plugin-clanker`. Loaded as `walletPlugin` (exported default and named from `plugin.ts`). Auto-enabled via `auto-enable.ts` when any signing path is present (EVM key, Solana key, or Steward credentials); opt-in otherwise.

## Plugin surface

**Actions (all promoted from `walletRouterAction` in `src/chains/wallet-action.ts`):**

| Name | Subaction | Description |
|------|-----------|-------------|
| `WALLET` | `transfer` | Move tokens to an external address (EVM or Solana). Always policy-checked. |
| `WALLET` | `swap` | Token swap via Li.Fi (EVM) or Jupiter (Solana). |
| `WALLET` | `bridge` | Cross-chain transfer via Li.Fi or CCTP. |
| `WALLET` | `gov` | On-chain governance: propose, vote, queue, execute. |
| `WALLET` | `pump_fun_buy` | Buy a pump.fun token on Solana via PumpPortal trade-local, local signing, browser coin-page open, and Solana RPC submission. |
| `WALLET` | `token_info` | Read-only token/market data (DexScreener, Birdeye, CoinGecko). |
| `WALLET` | `search_address` | Birdeye wallet/portfolio lookup by address. |
| `WALLET` | `token_safety` | Read-only GoPlus rug-risk check of one Solana mint (authorities, Token-2022 extensions, holder concentration, liquidity) with an avoid/caution/no-major-flags verdict. |
| `WALLET` | `onchain_token_safety` | Read-only on-chain Solana mint safety check from `SOLANA_RPC_URL` only (no API key, no signing; PROVIDER_UNAVAILABLE when unset): token program, supply, mint/freeze authority, Token-2022 risk extensions decoded, other extensions by name, largest token accounts' share of supply (accounts, not owners; RPC returns ≤20). A check that could not run reads UNKNOWN, never a pass. Dispatched before `runWalletRouter`; never reaches `WalletBackend`, SolanaService key paths or the confirmation gate. |
| `WALLET` | `token_pairs` | Read-only DexScreener lookup of one Solana mint's pools (price, liquidity, 24h volume, pool age). No key. Total liquidity under $10K, an oldest pool under a day, or no pool reporting its age adds caution; it never clears a GoPlus flag. |
| `WALLET` | `social_signal` | Read-only LunarCrush lookup by ticker (Galaxy Score, AltRank, sentiment, social volume). Needs `LUNARCRUSH_API_KEY`; without it, returns the add-a-key step and sends nothing. A Galaxy Score under 30 adds caution; the signal never clears a GoPlus flag. |
| `TRADE` | `inspect_account`, `inspect_session`, `submit_order` | Governed Steward trading account/session inspection and confirmed order intent for Hyperliquid and Polymarket. |

Similes handled: `SWAP`, `SWAP_SOLANA`, `TRANSFER`, `TRANSFER_TOKEN`, `WALLET_SWAP`, `WALLET_TRANSFER`, `CROSS_CHAIN_TRANSFER`, `PREPARE_TRANSFER`, `WALLET_ACTION`, `WALLET_GOV`, `PUMP_FUN_BUY`, `PUMPFUN_BUY`, `TOKEN_INFO`, `BIRDEYE_LOOKUP`, `BIRDEYE_SEARCH`, `WALLET_SEARCH_ADDRESS`, plus `TOKEN_SECURITY` (owned by the promoted `WALLET_ONCHAIN_TOKEN_SAFETY` virtual, whose automatic simile is `ONCHAIN_TOKEN_SAFETY`). The parent also routes `action=TOKEN_SECURITY` to `onchain_token_safety`. The on-chain virtual deliberately claims neither `TOKEN_SAFETY` nor `CHECK_TOKEN_SAFETY`: the third-party plugin-x402-finance registers an action named `CHECK_TOKEN_SAFETY` with simile `TOKEN_SAFETY` for its EVM honeypot check. Note that promotion gives the GoPlus `token_safety` subaction's virtual (`WALLET_TOKEN_SAFETY`) the automatic simile `TOKEN_SAFETY`, so that name is shared with plugin-x402-finance when both plugins are loaded.

All on-chain subactions (`transfer`, `swap`, `bridge`, `gov`, `pump_fun_buy`) require a user confirmation turn before execution. `mode=prepare` (default) stages without signing. Setting `mode=execute` does **not** bypass the gate — submission only happens after a confirmed reply turn. `dryRun=true` returns metadata without signing. `mode=simulate` (GH #16613) is a third, non-broadcasting mode: the handler builds the real transaction (real Jupiter quote/swap-tx or real PumpPortal trade-local build, whichever the subaction uses) and runs `connection.simulateTransaction({ sigVerify: false, replaceRecentBlockhash: true })` against it instead of signing and sending. It needs only the wallet's public key — never a private key or a `WalletBackend` signer — so it cannot authorize or lead to a live submission, and it skips the confirmation gate entirely (`requiresWalletFinancialConfirmation` returns `false` for it, same as `dryRun`). An RPC-reported revert is a *typed, successful* simulation (`success: false` with `err`/`logs`), never a thrown error or a fabricated success. Supported today for Solana `swap` and `pump_fun_buy` only; every other handler/subaction combination returns a typed `SIMULATION_UNSUPPORTED` router failure rather than silently falling back to `execute()` or the `prepare` echo.

**Providers:**

| Name | File | Description |
|------|------|-------------|
| `wallet` | `src/providers/wallet-provider.ts` | Injects EVM + Solana addresses into planner context (finance/crypto/wallet contexts, OWNER+ role gate). |
| `stewardTrading` | `src/providers/steward-trading-provider.ts` | Injects Steward trading capability and governed Hyperliquid/Polymarket session status without secrets. |
| `evmWalletProvider` | `src/chains/evm/providers/wallet.ts` | EVM-specific wallet context (viem `Account`). |
| `tokenBalanceProvider` | `src/chains/evm/providers/get-balance.ts` | EVM token balances. |
| `agentPortfolioProvider` | `src/analytics/birdeye/providers/agent-portfolio-provider.ts` | Birdeye portfolio for configured `BIRDEYE_WALLET_ADDR`. Registered when that setting is present. |
| `marketProvider` | `src/analytics/birdeye/providers/market.ts` | Birdeye market context. |
| `trendingProvider` | `src/analytics/birdeye/providers/trending.ts` | Birdeye trending tokens. Skipped if `BIRDEYE_NO_TRENDING=true`. |
| Solana `walletProvider` | `src/chains/solana/providers/wallet.ts` | Solana wallet context (balance, address). Registered at init. |

**Services:**

| Name | Service type key | File | Description |
|------|-----------------|------|-------------|
| `WalletBackendService` | `"wallet-backend"` | `src/services/wallet-backend-service.ts` | Core signing router — resolves `WalletBackend`, registers chain handlers, dispatches `routeWalletAction`. |
| `StewardTradingService` | `"steward-trading"` | `src/services/steward-trading-service.ts` | Governed Steward trading HTTP client for Hyperliquid/Polymarket sessions, accounts, and idempotent order submission. |
| `EVMService` | EVM service type | `src/chains/evm/service.ts` | EVM RPC + wallet management. |
| `SolanaService` | `SOLANA_SERVICE_NAME` | `src/chains/solana/service.ts` | Solana RPC, swap routing (Jupiter), portfolio. |
| `SolanaWalletService` | compat alias | `src/chains/solana/service.ts` | Compatibility alias for consumers expecting the old service name. |
| `BirdeyeService` | `BIRDEYE_SERVICE_NAME` | `src/analytics/birdeye/service.ts` | Birdeye API client (market, portfolio, trending). |
| `DexScreenerService` | dexscreener type | `src/analytics/dexscreener/service.ts` | DexScreener pair/token lookup. |
| `TokenInfoService` | `TOKEN_INFO_SERVICE_TYPE` | `src/analytics/token-info/service.ts` | Multi-provider token info dispatcher. |

**Routes (HTTP):**

`handleWalletRoutes` in `src/api/wallet-routes.ts` is mounted by `@elizaos/agent`'s HTTP server. Endpoints cover wallet generate, import, balances, export, config, chain/RPC settings, the crypto terminal's authenticated real trades (`GET /api/wallet/terminal/trade/status`, `POST .../review`, `POST .../execute`, implemented in `src/api/terminal-trade.ts`), and its Kraken/OKX spot limit orders (`GET /api/wallet/terminal/exchange/status`, `GET .../orders`, `POST .../review`, `.../execute`, `.../refresh`, `.../cancel`, implemented in `src/api/terminal-exchange.ts` over the signed clients in `src/api/exchange-venues.ts`). Solana-specific REST routes live in `src/chains/solana/routes/` and are registered directly on the plugin's `routes` array.

EVM sign routes live in `src/chains/evm/routes/sign.ts`.

## Layout

```
plugins/plugin-wallet/
  auto-enable.ts               Auto-enable logic (env-read only, no service imports)
  characters/                  Crypto Queen character; runs on local Ollama via
                               @elizaos/plugin-zerollama (README.md has the run steps,
                               crypto-queen.env.example the settings for every plugin
                               it loads)
  src/
    index.ts                   Package barrel — re-exports everything
    plugin.ts                  walletPlugin object (services/providers/actions/init/dispose)
    core-augmentation.ts       Augments @elizaos/core interfaces with wallet types
    contracts.ts               On-chain contract type definitions and exports
    register-routes.ts         Route registration helpers
    wallet-action.ts           Top-level wallet action re-export
    characters/                Crypto Queen character test and `check:crypto-queen`
                               setup check (Ollama models, Solana RPC and key, storage)
    actions/
      failure-codes.ts         Failure code constants
      intent-trajectory.ts     Intent trajectory types
    browser-shim/              Browser environment shim (build-shim.ts, shim.template.js)
    chains/
      wallet-action.ts         walletRouterAction (WALLET action, all subactions)
      registry.ts              registerDefaultWalletChainHandlers (EVM + Solana + pump.fun)
      evm/
        index.ts               evmPlugin (sub-plugin composed into walletPlugin)
        service.ts             EVMService
        chain-handler.ts       EvmWalletChainHandler (transfer/swap/bridge/gov)
        bridge-router.ts       Li.Fi + CCTP bridge routing
        gov-router.ts          On-chain governance routing
        providers/             evmWalletProvider, tokenBalanceProvider
        routes/sign.ts         EVM sign/verify HTTP routes
        dex/                   Uniswap V3, Aerodrome, PancakeSwap V3 DEX adapters
      solana/
        index.ts               solanaPlugin (sub-plugin composed into walletPlugin)
        service.ts             SolanaService, SolanaWalletService
        keypairUtils.ts        Key loading from settings/env
        providers/wallet.ts    Solana wallet provider
        routes/                Solana REST routes
        dex/                   Raydium, Orca, Meteora DEX adapters
    lib/
      server-wallet-trade.ts   canUseLocalTradeExecution, resolveTradePermissionMode helpers
      wallet-export-guard.ts   Wallet export audit log and guard
    services/
      wallet-backend-service.ts  WalletBackendService — top-level chain router
    wallet/
      backend.ts               WalletBackend interface + SolanaSigner + WalletAddresses
      local-eoa-backend.ts     LocalEoaBackend (raw private keys from env/keychain)
      steward-backend.ts       StewardBackend (cloud/mobile multi-tenant signing)
      select-backend.ts        resolveWalletBackend (auto/local/steward selection)
      pending.ts               SignScope, SignResult types
      errors.ts                WalletBackendNotConfiguredError, StewardUnavailableError
    providers/
      wallet-provider.ts       walletProvider (addresses into planner context)
      canonical-provider.ts    CanonicalProvider interface definition
    analytics/
      birdeye/                 BirdeyeService, market/trending/portfolio providers
      dexscreener/             DexScreenerService, plus the token-pairs client and WALLET
                               token_pairs handler (shared with the terminal's pairs route)
      token-info/              TokenInfoService (multi-provider dispatcher)
      goplus/                  GoPlus Solana token security client + WALLET token_safety handler
                               (shared with the terminal's token safety route)
      lunarcrush/              LunarCrush v4 social signal client + WALLET social_signal handler
                               (shared with the terminal's social route)
      token-safety/            On-chain Solana mint safety check (WALLET onchain_token_safety)
      lpinfo/                  kaminoPlugin, lpinfoPlugin, steerPlugin re-exports
      news/                    defiNewsPlugin, NewsDataService
    lp/
      lp-manager-entry.ts      lpManagerPlugin (Uniswap/Aerodrome/Raydium/Orca/Meteora LP)
    sdk/
      index.ts                 ERC-6551 wallet-core, x402, CCTP, escrow, swap, identity
      abi.ts                   AgentAccountV2Abi, AgentAccountFactoryV2Abi
      wallet-core.ts           createWallet, setSpendPolicy, agentTransferToken, checkBudget
      convenience.ts           x402 convenience helpers (reads X402_* env vars)
      x402/                    x402 micropayment protocol types + helpers
    policy/
      policy.ts                PolicyModule (spend-policy enforcement)
    audit/
      audit-log.ts             AuditLogRow schema (hash-chained, append-only)
    security/
      wallet-context-safety.ts   assertWalletFinancialActionAllowed, assertEvmTransferRecipientAuthorized
      wallet-financial-confirmation.ts  requireConfirmation gate for on-chain writes
    api/
      wallet-routes.ts         handleWalletRoutes — mounted by @elizaos/agent HTTP server
      terminal-trade.ts        Terminal real trades: review (build + simulate the Jupiter
                               swap, hold its bytes 60s) and execute (sign those bytes)
      terminal-exchange.ts     Terminal Kraken/OKX limit orders: review (venue check +
                               funds, hold 60s), execute once, session journal
      exchange-venues.ts       Signed Kraken and OKX REST clients (keys only in headers)
      __tests__/               Terminal trade route harness (Jupiter/RPC doubles, real signer)
    mcp/                       Read-only terminal MCP server: tool catalog and GET-only
                               dispatch to /api/wallet/terminal/* (terminal-tools.ts),
                               low-level SDK stdio glue (server.ts), `mcp` entry
    routes/
      plugin.ts                Additional plugin route exports
      wallet-terminal-market-route.ts  Public read-only market list and price
                               history for the crypto terminal: CoinGecko, falling
                               back to CoinPaprika when CoinGecko fails
      coinpaprika-backup.ts    CoinPaprika URLs and parsers for that backup
      wallet-terminal-token-safety-route.ts  Public read-only GoPlus Solana token
                               safety report (checks + avoid/caution verdict)
      wallet-terminal-pairs-route.ts  Public read-only DexScreener pools and liquidity
                               for one Solana mint
      wallet-terminal-social-route.ts  Authenticated read-only LunarCrush social signal
                               by ticker (the key stays on the server)
    types/
      wallet-router.ts         WalletRouterParams, WalletRouterResult, WalletChainHandler interface
    register.ts                Renderer boot side-effect entry (elizaos.appRegister:"register");
                               imports ui/register-routes.ts
    ui.ts                      `@elizaos/plugin-wallet/ui` subpath entry (re-exports ui/index.ts)
    ui/                        Wallet inventory UI surface
      index.ts                 UI barrel; side-effect imports register-routes.ts
      plugin.ts                walletAppPlugin descriptor (name "@elizaos/plugin-wallet:ui",
                               packageName "@elizaos/plugin-wallet"; shell nav tab /inventory,
                               GUI view /wallet via dist/views/bundle.js, wallet.status widget)
      register-routes.ts       registerAppRoutePluginLoader + registerAppShellPage +
                               registerBuiltinWidgets (must run once at boot)
      InventoryView.tsx        GUI wallet view (Escape wrapper around InventoryAppView)
      CryptoTerminalView.tsx   /crypto terminal: live markets, watchlist, charts, paper
                               orders, paper portfolio, price alerts, token safety,
                               Real trade tab, HUNT/SLEEP/OFF mode, PIN lock, and the
                               wallet dashboard tab
      terminal/                Paper ledger, operating mode, price alerts, and PIN lock
                               (pure), terminal data hooks, price chart, lock screen,
                               RealTradePanel (review dialog and confirm tap)
      InventoryView.interact.ts  `interact` view capability handler
      wallet-view-bundle.ts    Entry for the standalone Vite view bundle (dist/views/bundle.js)
      components/              InventoryAppView DOM dashboard
      inventory/               Chain config, hooks, token/NFT helpers, logos
      widgets/                 wallet.status chat-sidebar widget
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-wallet clean         # remove build output
bun run --cwd plugins/plugin-wallet build         # build package artifacts
bun run --cwd plugins/plugin-wallet typecheck     # TypeScript typecheck
bun run --cwd plugins/plugin-wallet check         # package check alias
bun run --cwd plugins/plugin-wallet lint          # mutating Biome check
bun run --cwd plugins/plugin-wallet lint:check    # read-only Biome check
bun run --cwd plugins/plugin-wallet format        # write formatting
bun run --cwd plugins/plugin-wallet format:check  # read-only formatting check
bun run --cwd plugins/plugin-wallet test          # run package tests
bun run --cwd plugins/plugin-wallet test:watch    # watch test lane
bun run --cwd plugins/plugin-wallet build:views   # standalone view bundle → dist/views/bundle.js
bun run --cwd plugins/plugin-wallet build:ui-types # UI declaration emit (tsconfig.ui.json)
bun run --cwd plugins/plugin-wallet check:crypto-queen # check packages/agent/.env and every connection Crypto Queen uses
bun run --cwd plugins/plugin-wallet mcp           # read-only terminal MCP server over stdio (needs the running agent)
```

`typecheck` runs both the Node tree (`tsconfig.json`, excludes `src/ui/**`) and the
React UI tree (`tsconfig.ui.json`, `jsx: react-jsx`, resolves workspace deps via
dist `.d.ts`).

## Config / env vars

All read via `runtime.getSetting()` (or `process.env` fallback where noted).

| Variable | Required | Description |
|----------|----------|-------------|
| `ELIZA_WALLET_BACKEND` | No | `local` \| `steward` \| `auto` (default: `auto`; case and spaces ignored). Auto = Steward when cloud-provisioned, else local. Any other value fails with `WALLET_BACKEND_MODE_INVALID` instead of falling back to auto. |
| `EVM_PRIVATE_KEY` | Local backend | 32-byte hex, 0x-prefixed. Local EOA signing key for EVM. |
| `SOLANA_PRIVATE_KEY` | Solana local | Base58-encoded Solana private key. |
| `STEWARD_API_URL` | Steward backend | Steward API base URL. |
| `STEWARD_AGENT_ID` | Steward backend | Agent identifier for Steward. |
| `STEWARD_AGENT_TOKEN` | Steward backend | Bearer token for Steward. |
| `STEWARD_TENANT_ID` | Steward backend | Tenant/user identifier. |
| `SOLANA_RPC_URL` | Solana features | RPC endpoint; skips Solana init if absent. Read directly by onchain_token_safety (no fallback). |
| `JUPITER_API_BASE_URL` | No | Jupiter Swap API base URL. Defaults to `https://lite-api.jup.ag/swap/v1`. |
| `SOLANA_NO_ACTIONS` | No | Set to `true` to skip Solana action registration. |
| `PUMPFUN_TRADE_LOCAL_URL` | No | PumpPortal local transaction API. Defaults to `https://pumpportal.fun/api/trade-local`. |
| `PUMPFUN_PRIORITY_FEE_SOL` | No | Priority fee in SOL for `pump_fun_buy`. Defaults to `0.00005`. |
| `PUMPFUN_POOL` | No | PumpPortal pool selector. Defaults to `auto`. |
| `BIRDEYE_API_KEY` | Birdeye features | Direct API key for Birdeye. Falls back to Eliza Cloud route if absent. |
| `BIRDEYE_WALLET_ADDR` | No | Enables `agentPortfolioProvider` for this wallet address. |
| `BIRDEYE_NO_TRENDING` | No | Set to `true` to skip trending provider registration. |
| `ELIZA_AGENT_WALLET_AUTO_ENABLE` | No | Set to `0` to disable auto-enable logic entirely. |
| `COINGECKO_API_KEY` | No | CoinGecko API key (also accepts `COINGECKO_DEMO_API_KEY` / `COINGECKO_PRO_API_KEY`). |
| `HELIUS_API_KEY` | No | Helius API key for enhanced Solana RPC. |
| `ELIZAOS_CLOUD_API_KEY` | No | Eliza Cloud API key for cloud-routing fallbacks. |
| `ELIZA_WALLET_EXPORT_TOKEN` | No | Unused by this plugin: `POST /api/wallet/export` answers 410, so keys never leave `packages/agent/.env` over HTTP. |
| `WALLET_TERMINAL_MAX_BUY_SOL` | No | Largest SOL amount one crypto terminal buy may spend. Defaults to `1`; a non-positive or non-numeric value is an error, not a fallback. |
| `WALLET_TERMINAL_JITO_TIP_LAMPORTS` | No | Tip a crypto terminal trade sent through Jito pays. Defaults to `100000`; must be a whole number from `1000` (Jito's minimum) to `4000000` (the RPC route's priority-fee cap), otherwise an error. |
| `KRAKEN_API_KEY`, `KRAKEN_API_SECRET` | No | Kraken API key and base64 secret for terminal exchange orders. Server-side only; trade rights only, never withdrawal rights. |
| `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE` | No | OKX API credentials for terminal exchange orders. Server-side only; trade rights only. |
| `OKX_API_BASE_URL` | No | https origin for OKX's REST API (default `https://www.okx.com`); a path, query or non-https URL is an error. |
| `WALLET_TERMINAL_MAX_ORDER_USD` | No | Largest value (quantity × limit price, or × the best bid for a sell limited below it, in the USD or USD-stablecoin quote) of one terminal exchange order. Defaults to `100`; a non-positive or non-numeric value is an error. |
| `ELIZA_TERMINAL_MCP_URL` | No | http(s) origin of the agent the terminal MCP server reads from. Defaults to `http://127.0.0.1:<agent port>`; anything with a path, query or credentials, or plain http to a host other than this machine, is an error. |
| `LUNARCRUSH_API_KEY` | No | LunarCrush API v4 key for the terminal's Social row and `WALLET action=social_signal`. Server-side only; never sent to the browser, logged, or returned. Unset means "Add a LunarCrush key" and no request. |
| `JITO_BLOCK_ENGINE_URL` | No | https Jito block engine the terminal's Jito route sends to. Defaults to `https://mainnet.block-engine.jito.wtf`. |
| `JITO_BLOCK_ENGINE_BACKUP_URLS` | No | Comma-separated https block engines tried in order when the first is unreachable or answers 429/5xx; the same signed bytes go to each, so a trade lands at most once. Defaults to Jito's ny, amsterdam, frankfurt and tokyo regions; `none` turns backups off. |
| `X402_SUPPORTED_NETWORKS` | No | Comma-separated network list for x402 SDK. |
| `X402_GLOBAL_DAILY_LIMIT` | No | Daily USDC spend cap for x402. |
| `X402_PER_REQUEST_MAX` | No | Per-request USDC cap for x402. |

EVM RPC (LP manager / chain routing): `ETHEREUM_RPC_URL` / `EVM_PROVIDER_MAINNET`, `BASE_RPC_URL` / `EVM_PROVIDER_BASE`, `BSC_RPC_URL` / `EVM_PROVIDER_BSC`, `ARBITRUM_RPC_URL` / `EVM_PROVIDER_ARBITRUM`, `AVALANCHE_RPC_URL`, `EVM_PROVIDER_OPTIMISM`, `EVM_PROVIDER_POLYGON`.

## How to extend

**Add a new chain handler (new EVM chain or alt-chain):**

1. Implement `WalletChainHandler` from `src/types/wallet-router.ts`. Provide `chain`, `name`, `supportedSubactions`, `metadata()`, `prepare()`, and `execute()`.
2. Register it in `src/chains/registry.ts` inside `registerDefaultWalletChainHandlers`, calling `service.registerChainHandler(handler)`.
3. No new action needed — `walletRouterAction` dispatches to all registered handlers via `WalletBackendService.routeWalletAction`.
4. Optionally implement `simulate()` and declare `simulation: { supported: true, supportedActions: [...] }` to support `mode=simulate` for a subaction (GH #16613). `simulate()` must build the real unsigned transaction and run it through `connection.simulateTransaction` — never sign, never call `sendTransaction`/`sendRawTransaction`/`confirmTransaction`. A handler that omits `simulate`/`simulation` gets a typed `SIMULATION_UNSUPPORTED` router failure for `mode=simulate`, never a silent fallback to `execute()` or to the `prepare` echo. See `fetchJupiterSwapTransaction`/`simulateSolanaSwap` and `fetchPumpFunTransaction`/`simulatePumpFunBuy` in `src/chains/registry.ts` for the reference shape (build helper shared with `execute`, plus a thin simulate wrapper).

**Add a new analytics provider:**

1. Implement `CanonicalProvider` from `src/providers/canonical-provider.ts`.
2. Register on the runtime inside `plugin.ts` `init` (use `runtime.registerProvider`).
3. Wire into `TokenInfoService` if it should be a token_info dispatch target.

**Add a new Birdeye route:**

Extend `src/analytics/birdeye/service.ts`. The service proxies all calls through `@elizaos/cloud-routing` (`resolveCloudRoute`), so no direct API key management is needed beyond adding the endpoint constant in `src/analytics/birdeye/constants.ts`.

## Conventions / gotchas

- **Financial confirmation gate.** All on-chain subactions (`transfer`, `swap`, `bridge`, `gov`, `pump_fun_buy`) go through `gateWalletFinancialExecution` in `src/security/wallet-financial-confirmation.ts`, which calls `requireConfirmation` from `@elizaos/core`. The LLM cannot bypass this by passing `mode=execute` alone — a confirmed reply turn is always required. Do not remove or short-circuit this gate. The crypto terminal's real trades are a separate, person-only path with their own gate (see the crypto terminal convention below); never route agent actions through it.
- **`WalletBackend` is the only signing path.** Providers and actions must never read raw private key env vars directly. Go through `WalletBackendService.getWalletBackend()` → `WalletBackend`.
- **pump.fun buy path.** `pump_fun_buy` is a Solana handler alias (`pumpfun`, `pump.fun`, `pump-fun`, `pump`) that requires `toToken`/`token` as a valid Solana mint and `amount` as SOL. It requests a serialized transaction from PumpPortal trade-local, signs through `WalletBackend.getSolanaSigner()` when available (falling back to the existing local `getWalletKey` Solana path), opens the token page through the optional browser service when available, then submits through `SOLANA_RPC_URL`. `mode=simulate` (GH #16613) shares the trade-local build (`fetchPumpFunTransaction`) but resolves only a public key (`resolvePumpFunPublicKey`, never `WalletBackend.getSolanaSigner()`/local keypair), skips the browser coin-page open, and runs `connection.simulateTransaction` instead of signing/sending.
- **onchain_token_safety is key-free and read-only.** It builds its own web3.js `Connection` from `SOLANA_RPC_URL` (`disableRetryOnRateLimit`, a 10 s `fetchMiddleware` deadline) and reads the mint with `getAccountInfoAndContext`, because `getAccountInfo` erases error types. It never calls `getWalletKey` or SolanaService key methods, which create and save a keypair, and never calls spl-token `getExtensionTypes` or `getExtensionData` on untrusted TLV (it walks the TLV with bounds checks instead). The RPC URL can embed a key, so the full URL, the password and every credential-named query value (`api-key`, `token`, `auth`, …) of any length, and each other component of 8 or more characters (query values, path segments, userinfo, host) are redacted from every message, and the URL never enters data, context or logs. Only a network-level failure (Node's `TypeError("fetch failed")`, a TypeError whose cause carries a socket code, or a Bun socket code) counts as `TRANSPORT_FAILED`; any other TypeError is `TOKEN_SAFETY_RPC_FAILED` and reaches the action boundary instead of degrading a check. Provider error bodies are kept complete in data and escaped onto one line in the text. Public RPCs often rate-limit `getTokenLargestAccounts`, so `holder_concentration` reads UNKNOWN there.
- **`handleWalletRoutes` is dependency-injected.** It imports nothing from `@elizaos/agent` to avoid a cycle. All agent-internal helpers (runtime lookup, auth, route helpers) are passed via `WalletRouteContext.deps` by `@elizaos/agent`'s server wiring.
- **Sub-plugins.** `evmPlugin` and `solanaPlugin` are composed into `walletPlugin` in `plugin.ts`. They are not intended to be loaded directly; always depend on `@elizaos/plugin-wallet`.
- **`SDK-LICENSE`** covers the `src/sdk/` subtree (originally from agent-wallet-sdk, MIT).
- **Auto-enable.** `auto-enable.ts` must remain a lightweight env-read module with no transitive plugin imports. The auto-enable engine loads it on every agent boot.
- **UI surface is subpath-only.** The package root (`.`) is the server barrel and must never import `src/ui/**`. Hosts import `@elizaos/plugin-wallet/ui` (components/barrel) or rely on the manifest-driven renderer boot (`elizaos.appRegister: "register"` → `src/register.ts`). `src/ui/register-routes.ts` must execute exactly once; duplicate imports create duplicate shell pages.
- **`walletAppPlugin` naming.** The UI descriptor is named `@elizaos/plugin-wallet:ui` with `packageName: "@elizaos/plugin-wallet"` so the views registry resolves the package dir while the app-route loader id stays distinct from the runtime `wallet` plugin. `normalizeAppRoutePluginId` strips `:ui`, so `ELIZA_SKIP_APP_ROUTE_PLUGINS=wallet` skips it.
- **Crypto terminal: paper orders, plus real trades only behind review and a tap.** `CryptoTerminalView` prices market-tab orders from the live `/api/wallet/terminal/*` routes but applies them only to the local `terminal/paper-ledger.ts` state persisted under `eliza:wallet:paper-terminal:v1`; paper orders never sign, call `WalletBackend`, or route through the `WALLET`/`TRADE` actions. Real trades live only in the Real trade tab (`terminal/RealTradePanel.tsx`) and go through `src/api/terminal-trade.ts`: review builds the exact Jupiter swap with `fetchJupiterSwapTransaction`, refuses a build whose fee payer is not the signing wallet, simulates it, and holds its unsigned bytes for 60 seconds; execute signs those same bytes through `WalletBackend.getSolanaSigner()` and sends them once. Never re-quote between review and execute, never sign a failed simulation, an expired or used review, or a review from a different wallet, and keep each buy within `WALLET_TERMINAL_MAX_BUY_SOL`. Each review picks a send route: `rpc` asks Jupiter for a capped priority fee and sends through the Solana RPC; `jito` asks Jupiter for a Jito tip instead (Jupiter takes one or the other under `prioritizationFeeLamports`) and sends only to the Jito block engine with `bundleOnly=true`, never also to the RPC, so a tipped trade is not broadcast publicly. The route is fixed at review time. Both steps need a trade permission that lets a person use the local wallet (`manual-local-key` or `agent-auto`) and refuse `x-eliza-agent-action` requests, so a terminal trade always rests on a person's tap; the tab may switch `user-sign-only` to `manual-local-key` only after its own confirm dialog, never to `agent-auto`. The review shows chain, mint, amounts, minimum output, slippage, destination, fee budget, route, simulation, send route (RPC or Jito, with its tip), and the GoPlus verdict, DexScreener Liquidity row and LunarCrush Social row for buys. The Liquidity row (`terminal/LiquidityRow.tsx`, public `GET /api/wallet/terminal/pairs`) is keyed by the checked mint and keeps no-pairs, unavailable and stale as distinct states; total liquidity under $10K, an oldest pool under a day, or no pool reporting its age may raise a "no major flags" display to caution but must never lower a GoPlus verdict, and no liquidity value may enable a trade. The Social row (`terminal/SocialSignalRow.tsx`, `GET /api/wallet/terminal/social`) is authenticated, keyed by the GoPlus symbol, and keeps no-key, not-tracked, unavailable and stale as distinct states; a Galaxy Score under 30 may raise a "no major flags" display to caution but must never lower a GoPlus verdict, and no social value may enable a trade. Its HUNT / SLEEP / OFF mode (`terminal/operating-mode.ts`, default SLEEP, persisted under `eliza:wallet:terminal-mode:v1`) changes only after a confirm dialog and records each change; OFF must make no automatic market request, and HUNT's scout only ranks movers for review. Price alerts (`terminal/price-alerts.ts`, persisted under `eliza:wallet:terminal-alerts:v1`) are one-shot in-terminal notices checked against live prices in HUNT and SLEEP and paused in OFF. No mode or alert may place, sign, or submit an order. The optional PIN lock (`terminal/pin-lock.ts`, `terminal/TerminalLock.tsx`, persisted under `eliza:wallet:terminal-pin:v1`) stores only a salted PBKDF2-SHA-256 hash, starts the terminal locked, auto-locks after idle, and fails closed on an unreadable record; while locked the view renders only the lock screen (wallet and trade tabs included) but keeps polling and checking alerts. "Forgot PIN" erases every `TERMINAL_STORAGE_KEYS` record, never just the PIN. It is a privacy lock for the terminal, not a key vault: never store keys, seeds, or the PIN itself there.
- **Exchange limit orders follow the same review-and-tap rule.** `src/api/terminal-exchange.ts` checks the exact order with the venue without placing it (Kraken `AddOrder validate=true`; OKX live instrument with lot, tick and minimum size), reads the available balance it would spend (Kraken `BalanceEx` minus what open orders hold), caps its value at `WALLET_TERMINAL_MAX_ORDER_USD` (a sell is valued at the venue's best bid when that is above its limit, since a low sell limit fills at the bid), and holds it 60 seconds; execute places that same order once with the client order id fixed at review. Every exchange route needs a trade permission that lets a person trade and refuses `x-eliza-agent-action` requests; never let the agent or an MCP tool reach review, execute, refresh or cancel. A send whose answer was lost, or that the venue answered with a "busy / unavailable / timed out" error (Kraken `EService:*` and `EGeneral:Internal error`, OKX 50001/50004/50013/50026), is journaled as `unknown` (never `rejected` or placed), and refresh looks it up by client order id among open and closed orders. Keys are read per request and appear only in signed headers, never in a response, error or log. The journal is in memory for the running process.
- **Terminal MCP server is read-only.** `src/mcp/terminal-tools.ts` maps each tool to one GET on an existing `/api/wallet/terminal/*` route and validates arguments before sending. Never add a tool that reaches `trade/review`, `trade/execute`, a wallet route, or any non-GET method; real trades stay a person's tap in the terminal. `@modelcontextprotocol/sdk` is an optional dependency imported dynamically through the SDK's low-level `Server` with JSON-schema tool lists (the high-level `McpServer.registerTool` requires Zod schemas).
- **View bundle.** `dist/views/bundle.js` is built by `vite.config.views.ts` (entry `src/ui/wallet-view-bundle.ts`, export `InventoryView`), not by the Node build. Both must run for a complete dist.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
