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

3. From the repository root, set these variables in the terminal you will
   start the agent from. A root `.env` file is not read by `bun run start`,
   because that script runs inside `packages/agent`; putting the same lines in
   `packages/agent/.env` also works.

   macOS, Linux, or Termux:

   ```bash
   export OLLAMA_BASE_URL=http://localhost:11434
   export OLLAMA_SMALL_MODEL=llama3.1
   export OLLAMA_LARGE_MODEL=llama3.1
   export OLLAMA_EMBEDDING_MODEL=nomic-embed-text
   export ELIZA_CHARACTER_PATH="$PWD/plugins/plugin-wallet/characters/crypto-queen.json"
   ```

   Windows PowerShell:

   ```powershell
   $env:OLLAMA_BASE_URL = "http://localhost:11434"
   $env:OLLAMA_SMALL_MODEL = "llama3.1"
   $env:OLLAMA_LARGE_MODEL = "llama3.1"
   $env:OLLAMA_EMBEDDING_MODEL = "nomic-embed-text"
   $env:ELIZA_CHARACTER_PATH = "$PWD\plugins\plugin-wallet\characters\crypto-queen.json"
   ```

4. From the repository root, run `bun install`, then `bun run start` for the
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
