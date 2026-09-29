#!/usr/bin/env python3
"""Appends an inline source map with x_google_ignoreList to content/inject.js so
DevTools hides it from stack traces / the Network tab's Initiator column."""
import base64, json, pathlib, re
p = pathlib.Path(__file__).resolve().parent.parent / 'content' / 'inject.js'
src = re.sub(r'\n//# sourceMappingURL=.*\s*$', '\n', p.read_text()).rstrip('\n') + '\n'
lines = src.count('\n') + 1
smap = {"version": 3, "file": "inject.js", "sources": ["doppel-internal/inject.js"],
        "sourcesContent": [src], "names": [], "mappings": ";".join(["AAAA"] + ["AACA"] * (lines - 1)),
        "x_google_ignoreList": [0]}
b64 = base64.b64encode(json.dumps(smap).encode()).decode()
p.write_text(src + '//# sourceMappingURL=data:application/json;base64,' + b64 + '\n')
print('ignore-list map added,', lines, 'lines')
