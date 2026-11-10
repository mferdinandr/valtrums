#!/usr/bin/env python3
"""Local-only JSON-RPC relay to the official Robinhood testnet RPC.

The ISP's DNS (Biznet RPZ) hijacks rpc.testnet.chain.robinhood.com, so the system resolver returns a block page.
This relay resolves the real address through Cloudflare DNS-over-HTTPS and connects to it directly, with the
correct TLS server name, so the connection is a normal verified TLS session to the real host.
It listens on 127.0.0.1 only, forwards only POST bodies of at most 1 MiB, holds no keys and logs no bodies.
"""
import http.client, json, ssl, socket, sys, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = sys.argv[2] if len(sys.argv) > 2 else "rpc.testnet.chain.robinhood.com"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18545
CTX = ssl.create_default_context()

GOOD = []  # addresses that worked before, tried first

def resolve() -> list:
    req = urllib.request.Request(f"https://cloudflare-dns.com/dns-query?name={HOST}&type=A", headers={"accept": "application/dns-json"})
    ans = json.load(urllib.request.urlopen(req, timeout=10)).get("Answer", [])
    ips = [a["data"] for a in ans if a["type"] == 1]
    return [ip for ip in GOOD if ip in ips] + [ip for ip in ips if ip not in GOOD]

class Conn(http.client.HTTPSConnection):
    def __init__(self, ip):
        super().__init__(HOST, 443, timeout=30, context=CTX)
        self._ip = ip
    def connect(self):
        sock = socket.create_connection((self._ip, 443), self.timeout)
        self.sock = CTX.wrap_socket(sock, server_hostname=HOST)  # certificate is verified against the real host name

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        if n <= 0 or n > 1_048_576:
            self.send_response(400); self.end_headers(); return
        body = self.rfile.read(n)
        try:
            last = None
            tried = []
            for ip in resolve() * 3:  # three rounds over the addresses
                try:
                    c = Conn(ip)
                    c.request("POST", "/", body=body, headers={"content-type": "application/json", "host": HOST})
                    r = c.getresponse(); data = r.read()
                    if ip not in GOOD: GOOD.append(ip)
                    break
                except Exception as e:  # this address is reset or unreachable on this network: try the next one
                    last = e
                    tried.append(type(e).__name__)
            else:
                sys.stderr.write("all attempts failed: " + ",".join(tried) + "\n"); sys.stderr.flush()
                raise last or RuntimeError("no address")
            self.send_response(r.status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
        except Exception as e:
            msg = json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "relay failed: " + type(e).__name__}}).encode()
            self.send_response(502); self.send_header("content-length", str(len(msg))); self.end_headers(); self.wfile.write(msg)
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
