# Crypto Queen local runtime

This repository includes a schema-valid `character.json` for Crypto Queen and a safe local runtime template at `config/crypto-queen.local.example.json`.

## What this profile enables

- Local elizaOS runtime
- Crypto Queen as the root sandbox character
- The canonical `@elizaos/plugin-wallet` surface explicitly enabled
- Read-only token and market analytics when their network providers are available
- No wallet private key, seed phrase, API token, or RPC credential stored in Git

The wallet plugin is intentionally enabled by configuration rather than by a signing credential. Its signing auto-enable path is disabled with `ELIZA_AGENT_WALLET_AUTO_ENABLE=0`, so merely adding a key later does not silently change the profile's intent.

## First local run

The runtime's durable configuration normally lives under the private eliza state directory, not in the repository. Do not overwrite an existing configuration.

From the repository root:

```bash
mkdir -p ~/.eliza
if [ -e ~/.eliza/eliza.json ]; then
  echo "Existing ~/.eliza/eliza.json found. Leave it in place and merge the wallet entry through Settings or by hand."
else
  cp config/crypto-queen.local.example.json ~/.eliza/eliza.json
fi

ELIZA_CHARACTER_PATH="$PWD/character.json" bun run dev:local
```

The root `character.json` is also discovered automatically in ordinary local/sandbox startup, but `ELIZA_CHARACTER_PATH` makes the intended character explicit.

## Read-only Solana setup

The first milestone does not require a signing key. Add an RPC URL through the runtime's protected Settings/Vault path when Solana RPC-backed features are needed. Do not commit it to this repository.

Useful read-only wallet capabilities already provided by elizaOS include:

- `token_info`: token/market lookup through the wallet analytics services
- `search_address`: public-address portfolio lookup when the configured provider supports it
- DexScreener token/pair lookup
- Birdeye market/portfolio/trending data when configured
- Solana RPC-backed inspection when `SOLANA_RPC_URL` is configured

## Transaction modes

Crypto Queen should progress through these modes in order:

1. **Read only**: research tokens, addresses, liquidity, authorities, and market data.
2. **Simulate**: for supported Solana actions, build the real unsigned transaction and run RPC simulation.
3. **Prepare**: stage a transaction without signing.
4. **Execute**: only after the wallet plugin's separate human confirmation turn.

Never put a seed phrase or raw private key in chat, this file, source control, or a prompt.

## Mobile limitation

The stock Android/iOS agent runtime currently filters its plugin load set to the mobile-safe allow-list. `@elizaos/plugin-wallet` is not in that stock-mobile allow-list, so this local profile should be validated in the Node/Termux or desktop runtime first. Mobile wallet/NovaMint integration is a separate implementation milestone and must not be represented as working until its bundle/runtime path is explicitly added and tested.
