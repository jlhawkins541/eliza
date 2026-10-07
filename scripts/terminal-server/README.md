# Local terminal server

`terminal_server.py` is the local, read-only proxy behind the standalone
terminal UI. It serves the four listed UI files and proxies DexScreener and
Jupiter so the browser avoids CORS. Chat and swap-building POSTs require a
same-origin `Origin`, a localhost `Host` and the `X-Eliza-Request: chat` header.

It imports two modules that live next to it on your machine and are not in this
repository: `portfolio.py` (`snapshot`, `valid_address`, `read_json`) and
`terminal_chat.py` (`ask_eliza`). The UI files go in `terminal/`.

## Run

```bash
python3 terminal_server.py            # http://localhost:8765
docker compose up --build             # same, published on 127.0.0.1 only
python3 -m unittest discover -s tests # 16 tests, no network, uses stand-in modules
```

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `TERMINAL_HOST` | `127.0.0.1` | Bind address; the Dockerfile sets `0.0.0.0`. |
| `TERMINAL_PORT` | `8765` | Port, also used in the allowed `Host` values. |
| `JUPITER_API_KEY` | unset | When set, Jupiter calls go to `api.jup.ag` with an `x-api-key` header. Unset uses the keyless `lite-api.jup.ag`, which Jupiter is retiring. |

`GET /api/health` reports `{"ok": true, "jupiter": "<host in use>"}`.
