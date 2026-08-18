#!/usr/bin/env python3
"""Add a test:xxx script to package.json and append it to the npm test chain.

Usage: python3 scripts/add-test-script.py <script-name> "<command>"
"""
import json
import sys

script_name, command = sys.argv[1], sys.argv[2]
path = "package.json"

with open(path) as f:
    pkg = json.load(f)

pkg["scripts"][script_name] = command
chain = pkg["scripts"]["test"]
entry = f" && npm run {script_name}"
if entry not in chain:
    pkg["scripts"]["test"] = chain + entry

with open(path, "w") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")

print(f"Added {script_name} and appended to test chain.")
