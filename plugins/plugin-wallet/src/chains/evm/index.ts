/**
 * EVM sub-plugin composed into `@elizaos/plugin-wallet`'s top-level
 * `walletPlugin` — not intended to be loaded standalone. Registers
 * `EVMService`, the EVM wallet/balance providers, the sign HTTP routes, and
 * the `WALLET` subactions promoted from `walletRouterAction`.
 */
import type { Action, IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { walletRouterAction } from "../wallet-action";
import { tokenBalanceProvider } from "./providers/get-balance";
import { evmWalletProvider } from "./providers/wallet";
import { evmSignRoutes } from "./routes/sign";
import { EVMService } from "./service";

export {
  createEvmWalletChainHandler,
  type EvmExecutedTransaction,
  type EvmPreparedResult,
  type EvmRouterResult,
  EvmWalletChainHandler,
  type EvmWalletChainHandlerOptions,
  type EvmWalletMode,
  type EvmWalletSubaction,
} from "./chain-handler";
export { initWalletProvider, WalletProvider } from "./providers/wallet";
export type { SupportedChain } from "./types";

export const evmPlugin: Plugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider, tokenBalanceProvider],
  services: [EVMService] as ServiceClass[],
  actions: promoteSubactionsToActions(walletRouterAction as Action, {
    overrides: {
      onchain_token_safety: {
        description:
          "subaction = onchain_token_safety: read-only on-chain Solana mint safety check from SOLANA_RPC_URL (param: address = mint); a check that could not run is UNKNOWN, never passed",
        // Promotion always adds the upper-snake subaction name as a simile, so
        // the subaction is named onchain_token_safety: plain TOKEN_SAFETY is a
        // simile of plugin-x402-finance's CHECK_TOKEN_SAFETY action (its Base
        // honeypot check), and a second claimant would make core retrieval
        // drop it as ambiguous and let a first-registered lookup take its
        // calls. For the same reason CHECK_TOKEN_SAFETY is not a simile here.
        similes: ["TOKEN_SECURITY"],
      },
    },
  }) as Action[],
  routes: evmSignRoutes,
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<EVMService>(EVMService.serviceType);
    await svc?.stop();
  },
};

export default evmPlugin;
