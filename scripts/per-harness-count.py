"""Run each test harness individually and report its self-declared test count.

Captures stdout + stderr (electron-log writes to stderr). Matches known
footer patterns; falls back to counting the harness's own 'PASS:' lines.
"""
import json
import re
import subprocess

pkg = json.load(open("package.json", encoding="utf-8"))
entries = sorted(k for k in pkg["scripts"] if k.startswith("test:"))

footer_res = [
    re.compile(r"tests passed \((\d+)\)", re.I),                  # "(33)"
    re.compile(r"All [^ ]+ tests PASSED \((\d+)/\d+\)", re.I),    # "(11/11)"
    re.compile(r"(\d+) test\(s\) passed, (\d+) failed", re.I),    # "62 passed, 0 failed"
    re.compile(r"\[[^\]]+\] done — (\d+) passed", re.I),          # "[memory] done — 12 passed"
    re.compile(r"All (?:Round \d+ )?[^,]*tests passed\.?", re.I), # generic footer
]
pass_re = re.compile(r"^PASS: ", re.M)

results = []
total = 0
for name in entries:
    out = subprocess.run(
        pkg["scripts"][name], shell=True, capture_output=True, text=True
    ).stdout
    err = subprocess.run(
        pkg["scripts"][name], shell=True, capture_output=True, text=True
    ).stderr
    out = out + "\n" + err
    n = None
    # use LAST matching footer (earlier timestamps may hit earlier patterns)
    for fx in footer_res:
        ms = fx.findall(out)
        if ms:
            val = ms[-1]
            if isinstance(val, tuple):
                val = val[0]
            try:
                n = int(val)
                break
            except ValueError:
                continue  # footer has no embedded count; fall through
    if n is None:
        n = len(pass_re.findall(out))
    results.append((name, n))
    total += n

for name, n in results:
    print(f"{name}: {n}")
print(f"SUITES: {len(results)}  TOTAL: {total}")
