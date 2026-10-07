"""Local, read-only terminal. Serves only explicitly listed public files.

Settings come from the environment: TERMINAL_HOST (bind address, default
127.0.0.1; use 0.0.0.0 inside Docker), TERMINAL_PORT (default 8765) and
JUPITER_API_KEY (when set, Jupiter calls go to api.jup.ag with the key instead
of the keyless lite-api.jup.ag, which Jupiter is retiring).
"""
import json
import os
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from portfolio import snapshot, valid_address, read_json
from terminal_chat import ask_eliza

ROOT = Path(__file__).parent / 'terminal'
HOST = os.environ.get('TERMINAL_HOST', '127.0.0.1')
PORT = int(os.environ.get('TERMINAL_PORT', '8765'))
ALLOWED_HOSTS = (f'localhost:{PORT}', f'127.0.0.1:{PORT}')
JUPITER_API_KEY = os.environ.get('JUPITER_API_KEY', '').strip()
JUPITER_BASE = 'https://api.jup.ag/swap/v1' if JUPITER_API_KEY else 'https://lite-api.jup.ag/swap/v1'

def jupiter_headers(extra=None):
    headers = {'User-Agent':'ElizaLocalTerminal/1.0','Accept':'application/json'}
    if JUPITER_API_KEY: headers['x-api-key'] = JUPITER_API_KEY
    headers.update(extra or {})
    return headers

def jupiter_get(url):
    request = urllib.request.Request(url, headers=jupiter_headers())
    with urllib.request.urlopen(request, timeout=15) as response: data = response.read(2_000_001)
    if len(data) > 2_000_000: raise ValueError('Response too large')
    return json.loads(data)

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        origin = self.headers.get('Origin')
        host = self.headers.get('Host')
        if host not in ALLOWED_HOSTS or origin != 'http://' + host or self.headers.get('X-Eliza-Request') != 'chat':
            self.send_error(403)
            return
        if self.path.startswith('/api/jupiter/swap'):
            try:
                size = int(self.headers.get('Content-Length','0'))
                if not 0 < size <= 120000 or self.headers.get('Content-Type') != 'application/json': self.send_error(400); return
                request = json.loads(self.rfile.read(size)); wallet = request.get('userPublicKey'); quote = request.get('quoteResponse')
                if not valid_address(wallet) or not isinstance(quote, dict): self.send_error(400); return
                body = json.dumps({'quoteResponse':quote,'userPublicKey':wallet,'wrapAndUnwrapSol':True,'dynamicComputeUnitLimit':True,'prioritizationFeeLamports':'auto'}).encode()
                req = urllib.request.Request(JUPITER_BASE + '/swap',data=body,headers=jupiter_headers({'Content-Type':'application/json'}))
                with urllib.request.urlopen(req,timeout=20) as response: data=response.read(500001)
                if len(data)>500000: raise ValueError()
                payload=json.loads(data)
                result=json.dumps({'swapTransaction':payload.get('swapTransaction'),'lastValidBlockHeight':payload.get('lastValidBlockHeight'),'simulationError':payload.get('simulationError')}).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(result))); self.end_headers(); self.wfile.write(result); return
            except Exception: self.send_error(502,'Jupiter transaction builder unavailable'); return
        if self.path != '/api/chat': self.send_error(404); return
        try:
            size = int(self.headers.get('Content-Length','0'))
            if not 0 < size <= 60000 or self.headers.get('Content-Type') != 'application/json':
                self.send_error(400)
                return
            request = json.loads(self.rfile.read(size))
            reply = {'text':ask_eliza(request.get('prompt'))}
            code = 200
        except ValueError as error:
            # Only deliberately authored errors, never provider exception details.
            reply = {'error':str(error) if type(error) is ValueError else 'Invalid request.'}
            code = 400
        except Exception:
            reply = {'error':'Local agent unavailable. Check installation and retry.'}
            code = 503
        data = json.dumps(reply).encode()
        self.send_response(code)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get('Host') not in ALLOWED_HOSTS:
            self.send_error(403)
            return
        path = urllib.parse.urlsplit(self.path)
        try:
            if path.path == '/api/health':
                data = json.dumps({'ok':True,'jupiter':'api.jup.ag' if JUPITER_API_KEY else 'lite-api.jup.ag'}).encode()
                kind = 'application/json'
            elif path.path == '/api/portfolio':
                address = urllib.parse.parse_qs(path.query).get('address', [''])[0]
                if not valid_address(address):
                    self.send_error(400)
                    return
                data = json.dumps(snapshot(address)).encode()
                kind = 'application/json'
            elif path.path == '/api/scout':
                profiles = read_json('https://api.dexscreener.com/token-profiles/latest/v1')
                sol = [p for p in profiles if p.get('chainId') == 'solana' and valid_address(p.get('tokenAddress',''))][:120]
                markets = []
                for start in range(0, len(sol), 30):
                    addresses = ','.join(p['tokenAddress'] for p in sol[start:start+30])
                    try: markets.extend(read_json('https://api.dexscreener.com/tokens/v1/solana/' + addresses))
                    except Exception: pass
                best = {}
                for pair in markets:
                    mint = pair.get('baseToken', {}).get('address')
                    if mint and ((pair.get('liquidity') or {}).get('usd') or 0) > ((best.get(mint,{}).get('liquidity') or {}).get('usd') or 0): best[mint] = pair
                result = []
                for profile in sol:
                    pair = best.get(profile['tokenAddress'])
                    result.append({'profile':profile,'pair':pair})
                data = json.dumps(result).encode(); kind = 'application/json'
            elif path.path == '/api/profiles':
                data = json.dumps(read_json('https://api.dexscreener.com/token-profiles/latest/v1')).encode()
                kind = 'application/json'
            elif path.path == '/api/search':
                query = urllib.parse.parse_qs(path.query).get('q', [''])[0].strip()
                if not 1 <= len(query) <= 120:
                    self.send_error(400)
                    return
                url = 'https://api.dexscreener.com/latest/dex/search?' + urllib.parse.urlencode({'q': query})
                request = urllib.request.Request(url, headers={'User-Agent':'ElizaLocalTerminal/1.0','Accept':'application/json'})
                # Search responses can legitimately exceed 2 MB for broad symbols
                # such as SOL. Parse the bounded upstream payload, then cap the
                # number of pairs returned to keep the browser responsive.
                with urllib.request.urlopen(request, timeout=15) as response:
                    data = response.read(8_000_001)
                if len(data) > 8_000_000:
                    raise ValueError('Response too large')
                parsed = json.loads(data)
                if isinstance(parsed, dict) and isinstance(parsed.get('pairs'), list):
                    parsed['pairs'] = parsed['pairs'][:500]
                    data = json.dumps(parsed, separators=(',', ':')).encode()
                kind = 'application/json'
            elif path.path == '/api/jupiter/quote':
                params = urllib.parse.parse_qs(path.query)
                mint = params.get('mint',[''])[0]; amount = params.get('amount',[''])[0]; slippage = params.get('slippage',['50'])[0]
                if not valid_address(mint) or not amount.isdigit() or not 1 <= len(amount) <= 30 or not slippage.isdigit() or not 0 <= int(slippage) <= 5000:
                    self.send_error(400); return
                target = JUPITER_BASE + '/quote?' + urllib.parse.urlencode({'inputMint':'So11111111111111111111111111111111111111112','outputMint':mint,'amount':amount,'slippageBps':slippage,'restrictIntermediateTokens':'true'})
                data = json.dumps(jupiter_get(target)).encode(); kind = 'application/json'
            else:
                files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/settings.js': ('settings.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
                if path.path not in files:
                    self.send_error(404)
                    return
                name, kind = files[path.path]
                data = (ROOT / name).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', kind + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-src https://dexscreener.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self.send_error(502, 'Market data temporarily unavailable')

    def log_message(self, *_):
        pass

if __name__ == '__main__':
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
