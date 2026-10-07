"""Exercises terminal_server.py over real HTTP with stand-in portfolio and chat modules; no network."""
import http.client
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
os.environ['TERMINAL_PORT'] = '18765'
os.environ.pop('JUPITER_API_KEY', None)

WALLET = 'So11111111111111111111111111111111111111112'
portfolio = types.ModuleType('portfolio')
portfolio.valid_address = lambda a: isinstance(a, str) and 32 <= len(a) <= 44 and a.isalnum()
portfolio.snapshot = lambda a: {'address': a, 'sol': 1.5}
portfolio.read_json = lambda url: []
chat = types.ModuleType('terminal_chat')


def ask_eliza(prompt):
    if not isinstance(prompt, str) or not prompt:
        raise ValueError('Prompt required.')
    if prompt == 'boom':
        raise RuntimeError('secret provider detail')
    return 'reply:' + prompt


chat.ask_eliza = ask_eliza
sys.modules['portfolio'] = portfolio
sys.modules['terminal_chat'] = chat

import terminal_server  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

PORT = terminal_server.PORT
HOSTHDR = f'127.0.0.1:{PORT}'
SAME_ORIGIN = {'Origin': 'http://' + HOSTHDR, 'X-Eliza-Request': 'chat', 'Content-Type': 'application/json'}


class FakeResponse:
    def __init__(self, payload):
        self.data = json.dumps(payload).encode()

    def read(self, n=-1):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def recorder(seen, payload):
    def fake(req, timeout):
        seen['url'] = req.full_url
        seen['key'] = req.get_header('X-api-key')
        return FakeResponse(payload)
    return fake


class TerminalServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        for name in ('index.html', 'app.js', 'settings.js', 'style.css'):
            (root / name).write_text(name)
        terminal_server.ROOT = root
        cls.server = ThreadingHTTPServer(('127.0.0.1', PORT), terminal_server.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=5)
        h = {'Host': HOSTHDR}
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res, data

    def chat(self, payload, **over):
        return self.request('POST', '/api/chat', json.dumps(payload), {**SAME_ORIGIN, **over})

    def test_health(self):
        res, data = self.request('GET', '/api/health')
        self.assertEqual(res.status, 200)
        self.assertEqual(json.loads(data), {'ok': True, 'jupiter': 'lite-api.jup.ag'})

    def test_static_files_and_security_headers(self):
        for path, body in (('/', 'index.html'), ('/app.js', 'app.js'), ('/settings.js', 'settings.js'), ('/style.css', 'style.css')):
            res, data = self.request('GET', path)
            self.assertEqual((res.status, data.decode()), (200, body))
        self.assertEqual(res.getheader('X-Content-Type-Options'), 'nosniff')
        self.assertIn("frame-ancestors 'none'", res.getheader('Content-Security-Policy'))

    def test_unlisted_path_is_404(self):
        self.assertEqual(self.request('GET', '/terminal_server.py')[0].status, 404)

    def test_foreign_host_rejected(self):
        self.assertEqual(self.request('GET', '/api/health', headers={'Host': 'evil.test'})[0].status, 403)

    def test_portfolio(self):
        res, data = self.request('GET', '/api/portfolio?address=' + WALLET)
        self.assertEqual((res.status, json.loads(data)['sol']), (200, 1.5))
        self.assertEqual(self.request('GET', '/api/portfolio?address=bad!')[0].status, 400)

    def test_chat_ok(self):
        res, data = self.chat({'prompt': 'hi'})
        self.assertEqual((res.status, json.loads(data)), (200, {'text': 'reply:hi'}))

    def test_chat_requires_marker_header(self):
        self.assertEqual(self.chat({'prompt': 'hi'}, **{'X-Eliza-Request': 'nope'})[0].status, 403)

    def test_chat_requires_same_origin(self):
        self.assertEqual(self.chat({'prompt': 'hi'}, Origin='http://evil.test')[0].status, 403)

    def test_chat_value_error_is_400(self):
        res, data = self.chat({'prompt': ''})
        self.assertEqual((res.status, json.loads(data)), (400, {'error': 'Prompt required.'}))

    def test_chat_hides_provider_errors(self):
        res, data = self.chat({'prompt': 'boom'})
        self.assertEqual(res.status, 503)
        self.assertNotIn('secret', data.decode())

    def test_search_validates_and_caps_pairs(self):
        self.assertEqual(self.request('GET', '/api/search?q=')[0].status, 400)
        with mock.patch('urllib.request.urlopen', return_value=FakeResponse({'pairs': list(range(900))})):
            res, data = self.request('GET', '/api/search?q=SOL')
        self.assertEqual((res.status, len(json.loads(data)['pairs'])), (200, 500))

    def test_scout_joins_profiles_with_best_pair(self):
        profiles = [{'chainId': 'solana', 'tokenAddress': WALLET}, {'chainId': 'ethereum', 'tokenAddress': WALLET}]
        pairs = [{'baseToken': {'address': WALLET}, 'liquidity': {'usd': 5}}, {'baseToken': {'address': WALLET}, 'liquidity': {'usd': 9}}]
        with mock.patch.object(terminal_server, 'read_json', side_effect=[profiles, pairs]):
            res, data = self.request('GET', '/api/scout')
        result = json.loads(data)
        self.assertEqual((res.status, len(result), result[0]['pair']['liquidity']['usd']), (200, 1, 9))

    def test_jupiter_quote_validates_and_uses_keyless_endpoint(self):
        self.assertEqual(self.request('GET', '/api/jupiter/quote?mint=' + WALLET + '&amount=abc')[0].status, 400)
        seen = {}
        with mock.patch('urllib.request.urlopen', side_effect=recorder(seen, {'outAmount': '1'})):
            res, data = self.request('GET', '/api/jupiter/quote?mint=' + WALLET + '&amount=1000')
        self.assertEqual((res.status, json.loads(data)), (200, {'outAmount': '1'}))
        self.assertTrue(seen['url'].startswith('https://lite-api.jup.ag/swap/v1/quote?'))
        self.assertIsNone(seen['key'])

    def test_jupiter_key_switches_to_api_jup_ag(self):
        seen = {}
        with mock.patch.object(terminal_server, 'JUPITER_API_KEY', 'k123'), \
                mock.patch.object(terminal_server, 'JUPITER_BASE', 'https://api.jup.ag/swap/v1'), \
                mock.patch('urllib.request.urlopen', side_effect=recorder(seen, {'outAmount': '2'})):
            res, _ = self.request('GET', '/api/jupiter/quote?mint=' + WALLET + '&amount=1000')
        self.assertEqual(res.status, 200)
        self.assertTrue(seen['url'].startswith('https://api.jup.ag/swap/v1/quote?'))
        self.assertEqual(seen['key'], 'k123')

    def test_jupiter_swap_returns_only_transaction_fields(self):
        body = json.dumps({'userPublicKey': WALLET, 'quoteResponse': {'x': 1}})
        upstream = {'swapTransaction': 'AAA', 'lastValidBlockHeight': 7, 'simulationError': None, 'extra': 'drop'}
        with mock.patch('urllib.request.urlopen', return_value=FakeResponse(upstream)):
            res, data = self.request('POST', '/api/jupiter/swap', body, SAME_ORIGIN)
        self.assertEqual((res.status, json.loads(data)), (200, {'swapTransaction': 'AAA', 'lastValidBlockHeight': 7, 'simulationError': None}))

    def test_upstream_failure_is_502(self):
        with mock.patch.object(terminal_server, 'read_json', side_effect=OSError('down')):
            self.assertEqual(self.request('GET', '/api/profiles')[0].status, 502)


if __name__ == '__main__':
    unittest.main()
