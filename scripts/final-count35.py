"""Final per-suite totals for the npm test chain.

Handles all footer styles and footer-only suites (npm squelched stdout so
only the header+footer appear). Each suite = its npm-run header segment
(assert lines within) plus, if its own footer immediately follows, the
count embedded in that footer (e.g. "PASSED (11/11)", "11 test(s) passed").
Footer-only suites have 0 header-segment lines by construction; their
embedded footer count is what we add.
"""
import re
import sys

log = open(sys.argv[1], encoding="utf-8", errors="replace").read()

footer_re = re.compile(
    r"^.*(?:tests passed[.!]?.*|done — [0-9]+ passed.*|tests PASSED \(([0-9]+)/[0-9]+\)[.!]?|"
    r"[0-9]+ test\(s\) passed, [0-9]+ failed|tests passed \(([0-9]+)\)[.!]?).*$",
    re.M,
)
footers = [(m.start(), m.group(0).strip(), m.group(1) or m.group(2)) for m in footer_re.finditer(log)]
header_re = re.compile(r"^> [^@]+@\S+ (test:[a-z0-9-]+)", re.M)
headers = [(mm.start(), mm.group(1)) for mm in header_re.finditer(log)]

bounds = sorted([(p, "ftr", v, c) for p, v, c in footers] + [(p, "hdr", v, None) for p, v in headers])

assert_re = re.compile(r"^\s*(?:PASS:|pass —|  pass|PASS )", re.M)
ts_re = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3}")

suites = {}
total = 0
for i, (pos, kind, label, embedded) in enumerate(bounds):
    end = bounds[i + 1][0] if i + 1 < len(bounds) else len(log)
    seg = log[pos:end]
    lines = seg.split("\n")
    n = sum(1 for ln in lines if assert_re.match(ln) and not ts_re.match(ln))
    if kind == "hdr":
        suites[label] = suites.get(label, 0) + n
    else:
        if embedded:
            suites.setdefault("footer-only", 0)
            suites["footer-only"] += int(embedded)
    total += n

print(f"header suites: {len(suites)}")
seg_total = sum(v for k, v in suites.items() if k != "footer-only")
emb = suites.get("footer-only", 0)
print(f"sum from header segments: {seg_total}")
print(f"embedded footer counts (footer-only suites): {emb}")
print(f"TOTAL tests: {seg_total + emb}")
