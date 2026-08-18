"""Attribute assert lines to suites in the npm test chain log.

Each suite footer ('All ... passed.', 'done — N passed', '[round] ...')
ends one harness. Between two consecutive footers (or from log start),
count all assert-print lines regardless of prefix style ('PASS: ',
'  pass — ', etc.), subtracting non-assert noise lines (timestamps, log
info lines) by excluding lines starting with a timestamp 'HH:MM:SS'.
"""
import re
import sys

log = open(sys.argv[1], encoding="utf-8", errors="replace").read()

footer_re = re.compile(
    r"^(?:.{0,80} tests passed[.!]?.*|"
    r"\[[a-z0-9-]+\] done — [0-9]+ passed.*|"
    r"All [A-Za-z][A-Za-z0-9 -]*tests passed.*|"
    r"All [A-Za-z][A-Za-z0-9 -]* tests passed\(([0-9]+)\).*)$",
    re.M,
)
footers = [(m.start(), m.group(0).strip()) for m in footer_re.finditer(log)]
# Also use npm run headers as boundaries if footers are sparse.
header_re = re.compile(r"^> [^@]+@\S+ (test:[a-z0-9-]+)", re.M)
boundaries = [(p, "ftr", v) for p, v in footers] + [
    (p, "hdr", v) for p, v in [(mm.group(1), mm.start()) for mm in header_re.finditer(log)]
]
# headers: capture group order fix
boundaries = [(p, "ftr", v) for p, v in footers] + [
    (st, "hdr", nm) for nm, st in [(mm.group(1), mm.start()) for mm in header_re.finditer(log)]
]
boundaries.sort()
print(f"boundaries: {len(boundaries)} ({len(footers)} footers)")

assert_re = re.compile(r"^\s*(?:PASS:|pass —|  pass|PASS )", re.M)
ts_re = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3}")

total = 0
for i, (pos, kind, label) in enumerate(boundaries):
    end = boundaries[i + 1][0] if i + 1 < len(boundaries) else len(log)
    seg = log[pos:end]
    lines = seg.split("\n")
    n = sum(1 for ln in lines if assert_re.match(ln) and not ts_re.match(ln))
    total += n
    print(f"  {kind:5s} {label[:65]:65s} {n}")
print("TOTAL assert lines:", total)
