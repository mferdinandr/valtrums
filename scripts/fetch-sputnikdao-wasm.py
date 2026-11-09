#!/usr/bin/env python3
"""Fetch the official SputnikDAO v3 contract wasm from the testnet factory.

The factory `sputnikv2.testnet` stores every DAO code version it can deploy and
returns the bytes through the read-only view `get_code(code_hash)`. The code
hash is the base58 SHA-256 of the wasm, so the download is verified against the
hash that the factory itself lists (`get_default_code_hash`).

Usage: scripts/fetch-sputnikdao-wasm.py [OUT_DIR]
Default OUT_DIR is contracts/target/sputnik (git-ignored). Prints the path.
Read-only: no account, key or transaction is involved.
"""
import base64
import hashlib
import json
import os
import sys
import urllib.request

RPC = os.environ.get("NEAR_TESTNET_RPC", "https://test.rpc.fastnear.com")
FACTORY = "sputnikv2.testnet"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
# Pinned: v3.31, upstream commit 7764926cfd3c47f62b5fcde231c251f3c3892887
# (factory metadata, read 2026-11-09). Override only to test another version.
PINNED_HASH = os.environ.get("SPUTNIK_CODE_HASH", "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH")


def b58(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = ALPHABET[rem] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def view(method: str, args: dict) -> bytes:
    body = {
        "jsonrpc": "2.0", "id": 1, "method": "query",
        "params": {
            "request_type": "call_function", "finality": "final",
            "account_id": FACTORY, "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        },
    }
    req = urllib.request.Request(RPC, json.dumps(body).encode(), {"content-type": "application/json"})
    reply = json.load(urllib.request.urlopen(req, timeout=120))
    result = reply.get("result", {})
    if "result" not in result:
        sys.exit(f"RPC error for {method}: {json.dumps(reply)[:400]}")
    return bytes(result["result"])


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "contracts", "target", "sputnik")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"sputnikdao2-{PINNED_HASH}.wasm")
    if os.path.exists(path):
        with open(path, "rb") as f:
            if b58(hashlib.sha256(f.read()).digest()) == PINNED_HASH:
                print(path)
                return
    wasm = view("get_code", {"code_hash": PINNED_HASH})
    digest = b58(hashlib.sha256(wasm).digest())
    if digest != PINNED_HASH:
        sys.exit(f"hash mismatch: expected {PINNED_HASH}, got {digest}")
    with open(path, "wb") as f:
        f.write(wasm)
    print(path)


if __name__ == "__main__":
    main()
