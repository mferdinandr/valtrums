#!/usr/bin/env python3
"""Local-only JSON-RPC relay to the official Robinhood RPC hosts.

The ISP's DNS (Biznet RPZ) hijacks rpc.testnet.chain.robinhood.com, so the system resolver returns a block page.
This relay resolves the real address through Cloudflare DNS-over-HTTPS and connects to it directly, with the
correct TLS server name, so the connection is a normal verified TLS session to the real host.
It listens on 127.0.0.1 only, forwards only POST bodies of at most 1 MiB, holds no keys and logs no bodies.

Usage: rpc-relay.py <port> [host]

Speed (needed by the custody verifier, which walks block headers one by one from the finalized head down to the
receipt block): the address list is cached for a minute, each worker thread keeps one upstream TLS connection, the
server answers several clients at once, and `eth_getBlockByNumber` for a numbered block at or below the latest
finalized block this relay has seen is cached, because such a block cannot change. On a cache miss it also fetches the
PREFETCH blocks below it in one batch, because the verifier walks downward one block at a time. Anything else is
forwarded as is.
"""
import http.client, json, re, ssl, socket, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = sys.argv[2] if len(sys.argv) > 2 else "rpc.testnet.chain.robinhood.com"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18545
CTX = ssl.create_default_context()

GOOD = []  # addresses that worked before, tried first
_ips = {"at": 0.0, "list": []}
_lock = threading.Lock()
_local = threading.local()
FINAL = {"n": -1}  # highest finalized block number seen in an answer to a "finalized" request
CACHE = {}  # block number -> JSON-RPC result of eth_getBlockByNumber(<number>, false)
HEX = re.compile(r"^0x[0-9a-fA-F]+$")
PREFETCH = 40  # headers fetched per batch below a missed block (the public RPC answers 429 to a batch of 100)
_prefetch_lock = threading.Lock()  # one batch at a time, so parallel verifiers never burst the upstream rate limit


def resolve() -> list:
    with _lock:
        if _ips["list"] and time.time() - _ips["at"] < 60:
            return list(_ips["list"])
    req = urllib.request.Request(f"https://cloudflare-dns.com/dns-query?name={HOST}&type=A", headers={"accept": "application/dns-json"})
    ans = json.load(urllib.request.urlopen(req, timeout=10)).get("Answer", [])
    ips = [a["data"] for a in ans if a["type"] == 1]
    ordered = [ip for ip in GOOD if ip in ips] + [ip for ip in ips if ip not in GOOD]
    with _lock:
        _ips.update(at=time.time(), list=ordered)
    return ordered


class Conn(http.client.HTTPSConnection):
    def __init__(self, ip):
        super().__init__(HOST, 443, timeout=30, context=CTX)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, 443), self.timeout)
        self.sock = CTX.wrap_socket(sock, server_hostname=HOST)  # certificate is verified against the real host name


def upstream(body: bytes):
    """POST to the real host, reusing this thread's connection and trying every address when it fails."""
    c = getattr(_local, "conn", None)
    if c is not None:
        try:
            c.request("POST", "/", body=body, headers={"content-type": "application/json", "host": HOST})
            r = c.getresponse()
            return r.status, r.read()
        except Exception:
            _local.conn = None
    last, tried = None, []
    for ip in resolve() * 3:  # three rounds over the addresses
        try:
            c = Conn(ip)
            c.request("POST", "/", body=body, headers={"content-type": "application/json", "host": HOST})
            r = c.getresponse()
            data = r.read()
            if ip not in GOOD:
                GOOD.append(ip)
            _local.conn = c
            return r.status, data
        except Exception as e:  # this address is reset or unreachable on this network: try the next one
            last = e
            tried.append(type(e).__name__)
    sys.stderr.write("all attempts failed: " + ",".join(tried) + "\n")
    sys.stderr.flush()
    raise last or RuntimeError("no address")


def block_number(req):
    """The block number of a cacheable request, or None."""
    if not isinstance(req, dict) or req.get("method") != "eth_getBlockByNumber":
        return None
    p = req.get("params")
    if not isinstance(p, list) or len(p) != 2 or p[1] is not False or not isinstance(p[0], str) or not HEX.match(p[0]):
        return None
    n = int(p[0], 16)
    return n if n <= FINAL["n"] else None


def prefetch(num: int) -> None:
    """Fill the cache with `num` and the blocks below it using one upstream batch. Failure is harmless."""
    with _prefetch_lock:
        if num in CACHE:  # another thread filled it while this one waited
            return
        low = max(0, num - PREFETCH + 1)
        calls = [{"jsonrpc": "2.0", "id": n, "method": "eth_getBlockByNumber", "params": [hex(n), False]} for n in range(num, low - 1, -1)]
        body = json.dumps(calls).encode()
        for attempt in range(4):
            try:
                status, data = upstream(body)
            except Exception:
                return
            if status == 429:  # rate limited: back off and retry
                time.sleep(3 * (attempt + 1))
                continue
            if status != 200:
                return
            try:
                for item in json.loads(data):
                    if isinstance(item, dict) and item.get("result") and isinstance(item.get("id"), int):
                        CACHE[item["id"]] = item["result"]
            except Exception:
                pass
            return


def remember_finalized(req, data: bytes):
    if isinstance(req, dict) and req.get("method") == "eth_getBlockByNumber" and isinstance(req.get("params"), list) and req["params"][:1] == ["finalized"]:
        try:
            r = json.loads(data).get("result")
            if r and r.get("number"):
                FINAL["n"] = max(FINAL["n"], int(r["number"], 16))
        except Exception:
            pass


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def reply(self, status: int, data: bytes):
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        if n <= 0 or n > 1_048_576:
            self.send_response(400)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        body = self.rfile.read(n)
        try:
            req = None
            try:
                req = json.loads(body)
            except Exception:
                pass
            num = block_number(req)
            if num is not None and num in CACHE:
                self.reply(200, json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": CACHE[num]}).encode())
                return
            if num is not None:
                prefetch(num)
                if num in CACHE:
                    self.reply(200, json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": CACHE[num]}).encode())
                    return
            status, data = upstream(body)
            remember_finalized(req, data)
            if num is not None and status == 200:
                try:
                    result = json.loads(data).get("result")
                    if result:
                        CACHE[num] = result
                except Exception:
                    pass
            self.reply(status, data)
        except Exception as e:
            msg = json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "relay failed: " + type(e).__name__}}).encode()
            self.reply(502, msg)

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
