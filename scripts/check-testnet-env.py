#!/usr/bin/env python3
"""Refuse a Vercel project configured for mainnet or live funding by this CD."""
from pathlib import Path
import os
import shlex
import sys


def validate(path: Path) -> None:
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        key, separator, raw = line.partition("=")
        if not separator:
            continue
        if key.strip() not in {"NEXT_PUBLIC_NEAR_NETWORK", "NEXT_PUBLIC_FUNDING_ROUTER"}:
            continue
        parts = shlex.split(raw, comments=True)
        values[key.strip()] = parts[0] if len(parts) == 1 else ""
    for key, expected in (("NEXT_PUBLIC_NEAR_NETWORK", "testnet"), ("NEXT_PUBLIC_FUNDING_ROUTER", "mock")):
        if values.get(key, os.environ.get(key)) != expected:
            raise ValueError(f"{key} must explicitly resolve to {expected} for this testnet deployment")


if __name__ == "__main__":
    validate(Path(sys.argv[1]))
    print("Deployment network and funding mode passed the testnet policy")
