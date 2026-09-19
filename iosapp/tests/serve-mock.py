#!/usr/bin/env python3
"""Serve the iOS build in a desktop browser, with a fake pedal behind it.

The page is assembled exactly as the app assembles it -- web/ shadowing the
shared app/, and the same transport swap AssetSchemeHandler performs -- then a
recorded capture is wired in as the accessory. So the whole client runs, answers
commands, and can be poked at phone width in devtools, with no device, no
pairing and no pedal.

    dev/serve-mock.py            # http://127.0.0.1:8766

choose_transport() below must stay byte-identical to the Swift one; run-tests.sh
compares them.
"""
import json, re, sys
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOTS = [HERE.parent / "web", HERE.parent.parent / "app"]
CAPTURE = HERE.parent.parent / "tools" / "protocol-20260908T150705Z.decoded.json"

TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
         ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
         ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".zip": "application/zip",
         ".py": "text/plain"}


def choose_transport(html: str) -> str:
    """The shim replaces the browser transport, in place so it still precedes
    iap.js; the two authentication scripts go, iOS having done that work."""
    out = html.replace('src="transport.js', 'src="transport-ea.js')
    for dropped in ("iap-auth.js", "iap-signature.js"):
        out = re.sub(r'<script src="%s[^"]*"></script>' % re.escape(dropped), "", out)
    return out


def inject_mock(html: str) -> str:
    """Dev only, and deliberately not part of choose_transport: the bridge has
    to exist before transport-ea.js runs, so both tags are synchronous and go
    immediately ahead of it."""
    tags = ('<script src="/__dev/native-bridge-mock.js"></script>'
            '<script src="/__dev/mock-init.js"></script>')
    return html.replace('<script src="transport-ea.js', tags + '<script src="transport-ea.js', 1)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        name = self.path.split("?", 1)[0].lstrip("/") or "index.html"

        if name == "__dev/mock-init.js":
            capture = json.loads(CAPTURE.read_text())
            body = ("installMockBridge(%s);\n" % json.dumps(capture)).encode()
            return self.send(body, "text/javascript")
        if name.startswith("__dev/"):
            return self.serve(HERE / name[len("__dev/"):])

        for root in ROOTS:
            candidate = (root / name).resolve()
            if not str(candidate).startswith(str(root.resolve())):
                continue
            if candidate.is_file():
                if name == "index.html":
                    html = inject_mock(choose_transport(candidate.read_text()))
                    return self.send(html.encode(), "text/html")
                return self.serve(candidate)
        self.send_error(404, "no %s in %s" % (name, [str(r) for r in ROOTS]))

    def serve(self, path: Path):
        if not path.is_file():
            return self.send_error(404, str(path))
        self.send(path.read_bytes(), TYPES.get(path.suffix, "application/octet-stream"))

    def send(self, body: bytes, kind: str):
        self.send_response(200)
        self.send_header("Content-Type", kind + ("; charset=utf-8" if kind.startswith("text") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    print("MS StompCtrl (iOS build, mock pedal) on http://127.0.0.1:%d" % port)
    print("Serving %s" % " then ".join(str(r) for r in ROOTS))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
