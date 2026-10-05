# Crypto Queen

`crypto-queen.json` is a Solana-focused, risk-first analyst character. It uses
the wallet plugin's read-only `WALLET` analytics (`token_info`,
`token_safety`) and never signs or sends a transaction without the wallet's
confirmation gate. It runs on a local [Ollama](https://ollama.com/) server
through `@elizaos/plugin-zerollama`, so no cloud API key is needed.

## Run it on Ollama

1. Install Ollama and start it, either with the desktop app or `ollama serve`.
2. Pull one chat model and one embedding model. The plugin never downloads
   models itself.

   ```bash
   ollama pull llama3.1
   ollama pull nomic-embed-text
   curl http://localhost:11434/api/tags   # both models should be listed
   ```

3. Copy the settings template into the file the agent reads, then fill it in:

   ```bash
   cp plugins/plugin-wallet/characters/crypto-queen.env.example packages/agent/.env
   ```

   Windows PowerShell:

   ```powershell
   Copy-Item plugins\plugin-wallet\characters\crypto-queen.env.example packages\agent\.env
   ```

   `bun run start` runs inside `packages/agent`, so it reads
   `packages/agent/.env`, not a root `.env`. Shell variables override the file.
   The template covers every plugin Crypto Queen loads:

   - **Character**: `ELIZA_CHARACTER_PATH` points at `crypto-queen.json`.
   - **`@elizaos/plugin-zerollama`**: `OLLAMA_BASE_URL` and the three
     `OLLAMA_*_MODEL` names you pulled in step 2.
   - **`@elizaos/plugin-wallet`**: `SOLANA_RPC_URL` (without it the wallet
     skips Solana, so balances, `token_info` and Real trade don't work) and,
     for real trades, `SOLANA_PRIVATE_KEY` of a separate hot wallet that holds
     only trading funds. `WALLET_TERMINAL_MAX_BUY_SOL` caps each terminal buy.
   - **`@elizaos/plugin-sql`**: nothing to set; it stores data in embedded
     PGlite unless you give it `POSTGRES_URL`.

   Never commit the filled-in `packages/agent/.env`; it holds your wallet key.

4. Check the setup. This reads the same file, asks Ollama which models are
   pulled, asks the Solana RPC for its health and the wallet's balance, and
   prints PASS, WARN or FAIL per plugin with the step that fixes each failure.
   It never prints the key.

   ```bash
   bun run --cwd plugins/plugin-wallet check:crypto-queen
   ```

5. From the repository root, run `bun install`, then `bun run start` for the
   agent alone or `bun run dev` for the agent with the app UI.

## If it still doesn't answer

- **`OLLAMA_MODEL_NOT_INSTALLED`**: a model named in an `OLLAMA_*_MODEL`
  variable is not pulled. When a variable is unset the plugin asks for
  `eliza-1-2b` or `eliza-1-4b`, which stock Ollama does not have, so set all
  three model variables.
- **Connection refused**: Ollama is not running at `OLLAMA_BASE_URL`. If it
  runs on another computer, start it there with `OLLAMA_HOST=0.0.0.0` and point
  `OLLAMA_BASE_URL` at `http://<that-computer>:11434`.
- **Errors mentioning `format` or a schema**: some small models reject
  structured output. Set `OLLAMA_DISABLE_STRUCTURED_OUTPUT=true`.
- **A cloud model answers instead**: remove other provider keys such as
  `OPENAI_API_KEY` from the environment so Ollama is the only model provider.

Every Ollama setting is listed in the
[plugin-zerollama guide](../../plugin-zerollama/CLAUDE.md#config--env-vars).
