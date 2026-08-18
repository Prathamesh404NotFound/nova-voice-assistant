"""Count assert() call sites (test count) per harness file."""
import glob
import re

files = sorted(glob.glob("src/main/test-*.js"))
total = 0
for f in files:
    src = open(f, encoding="utf-8").read()
    # assert call: line where assert( is called — the harness defines a local
    # `function assert(...)` (or const assert) and then calls assert(name, cond)
    calls = len(re.findall(r"^ {0,4}assert\(", src, re.M))
    # some harnesses define function assert with params on same line; calls are
    # lines starting (after optional space) with "assert(" — exclude the def by
    # checking next char is not "("
    defn = len(re.findall(r"function assert\(|const assert = |let assert = ", src))
    n = calls - defn
    total += n
    print(f"{f}: {n}")
print(f"TOTAL: {total} across {len(files)} harnesses")
