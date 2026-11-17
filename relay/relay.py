"""claude-account-switcher relay.

A loopback relay for Claude Code sessions. The companion plugin points a session at
http://127.0.0.1:48620/acct/<name>/<key>; this relay checks <key> against relay.key, then replaces the Authorization header with <name>'s
long-lived token from tokens.json (beside this file) and forwards the request to api.anthropic.com,
streaming the response back. It binds 127.0.0.1 only and never logs a token.

Files beside this script:
  tokens.json   {"<name>": {"token": "...", "createdAt": "...", "expiresAt": "..."}, ...}
                (a bare string value is accepted too)
  relay.alive   heartbeat rewritten every 10 s: port, pid, time, account names
  relay.log     one line per request: account, method, path, status, bytes, seconds
  relay.key     random secret, created on first start (mode 600). Every routed request and
                /refresh must carry it in the path, so other local programs cannot spend the
                accounts through the relay. The key is never logged.
Health: GET /health -> {"ok": true, "accounts": [names]}
Refresh: POST /refresh/<key> -> sends each account one tiny model request (1 output token) so its
                usage windows are fresh in relay.alive. It spends a little usage and starts that
                account's 5-hour window if none is running.
"""
import hmac
import http.client
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENS = os.path.join(HERE, "tokens.json")
LOG = os.path.join(HERE, "relay.log")
ALIVE = os.path.join(HERE, "relay.alive")
KEYFILE = os.path.join(HERE, "relay.key")
PORT = 48620
UPSTREAM = "api.anthropic.com"
HOP = {"host", "authorization", "x-api-key", "connection", "keep-alive", "transfer-encoding", "content-length", "proxy-authorization", "te", "trailer", "upgrade"}


def load_key() -> str:
    """Return the relay secret, creating it (mode 600) on first start."""
    try:
        with open(KEYFILE, encoding="utf-8") as f:
            k = f.read().strip()
        if k:
            return k
    except OSError:
        pass
    k = secrets.token_urlsafe(32)
    fd = os.open(KEYFILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(k + "\n")
    return k


KEY = ""
# Request headers of the last routed model request, minus credentials, reused by /refresh so the
# probe looks like a Claude Code request (anthropic-version, anthropic-beta, user-agent, ...).
LAST_HEADERS: dict = {}
PROBE_MODEL = "claude-haiku-5-5"


def key_ok(k: str) -> bool:
    return bool(KEY) and hmac.compare_digest(k.encode(), KEY.encode())


def log(msg: str) -> None:
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def read_store() -> dict:
    try:
        with open(TOKENS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def load_tokens() -> dict:
    """Return {name: token}. Accepts object entries ({"token": ...}) or bare strings."""
    out = {}
    for name, entry in read_store().items():
        tok = entry.get("token") if isinstance(entry, dict) else entry
        if isinstance(tok, str) and tok:
            out[name] = tok
    return out


def load_expiry() -> dict:
    """Return {name: expiresAt ISO string} for entries that record one (never the token)."""
    return {n: e["expiresAt"] for n, e in read_store().items() if isinstance(e, dict) and e.get("expiresAt")}


USAGE: dict = {}  # {name: {"at", "h5", "h5_reset", "d7", "d7_reset"}} from the last reply that carried the headers
_RL = "anthropic-ratelimit-unified-"


def note_usage(name: str, resp) -> None:
    """Remember the account's own usage windows as the API reports them on a reply (never a token)."""
    try:
        d7, h5 = resp.getheader(_RL + "7d-utilization"), resp.getheader(_RL + "5h-utilization")
        if d7 is None and h5 is None:
            return
        USAGE[name] = {
            "at": time.time(),
            "h5": float(h5) if h5 is not None else None,
            "h5_reset": int(resp.getheader(_RL + "5h-reset") or 0) or None,
            "d7": float(d7) if d7 is not None else None,
            "d7_reset": int(resp.getheader(_RL + "7d-reset") or 0) or None,
        }
    except (TypeError, ValueError):
        pass


class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence default stderr logging
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "accounts": sorted(load_tokens().keys())})
            return
        if self.path.startswith("/refresh/"):
            if not key_ok(self.path[len("/refresh/"):]):
                self._json(403, {"error": "bad key"})
                return
            self._json(200, {"ok": True, "results": refresh_all(), "usage": dict(USAGE)})
            return
        parts = self.path.split("/", 4)  # ['', 'acct', '<name>', '<key>', '<rest>']
        if len(parts) < 5 or parts[1] != "acct":
            self._json(404, {"error": "expected /acct/<name>/<key>/..."})
            return
        if not key_ok(parts[3]):
            log(f"rejected request for '{parts[2]}': bad key")
            self._json(403, {"type": "error", "error": {"type": "permission_error", "message": "account-switcher relay: bad key"}})
            return
        name, rest = parts[2], "/" + parts[4]
        token = load_tokens().get(name)
        if not token:
            log(f"no token for account '{name}'")
            self._json(401, {"type": "error", "error": {"type": "authentication_error", "message": f"account-switcher relay: no token stored for account '{name}'"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        if self.command == "POST" and rest.startswith("/v1/messages") and "count_tokens" not in rest:
            LAST_HEADERS.clear()
            LAST_HEADERS.update(headers)
            try:
                m = json.loads(body or b"{}").get("model", "")
                if "haiku" in m:
                    globals()["PROBE_MODEL"] = m
            except ValueError:
                pass
        headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Length"] = str(len(body))
        headers["Connection"] = "close"
        t0 = time.time()
        try:
            up = http.client.HTTPSConnection(UPSTREAM, timeout=600)
            up.request(self.command, rest, body=body, headers=headers)
            resp = up.getresponse()
        except Exception as e:  # upstream unreachable
            log(f"{name} {self.command} {rest} upstream error {type(e).__name__}")
            self._json(502, {"type": "error", "error": {"type": "api_error", "message": f"account-switcher relay: upstream error {type(e).__name__}"}})
            return
        note_usage(name, resp)
        self.send_response(resp.status, resp.reason)
        for k, v in resp.getheaders():
            if k.lower() in ("transfer-encoding", "content-length", "connection"):
                continue
            self.send_header(k, v)
        self.send_header("Connection", "close")
        self.end_headers()
        sent = 0
        try:
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                sent += len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            up.close()
        log(f"{name} {self.command} {rest} -> {resp.status} {sent}B {time.time() - t0:.1f}s")
        self.close_connection = True

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _handle


def refresh_one(name: str, token: str) -> str:
    """Send one tiny model request as <name> so its usage headers are recorded. Returns a status."""
    body = json.dumps({
        "model": PROBE_MODEL,
        "max_tokens": 1,
        "system": "You are Claude Code, Anthropic's official CLI for Claude.",
        "messages": [{"role": "user", "content": "ok"}],
    }).encode()
    headers = dict(LAST_HEADERS) or {"anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20"}
    headers.setdefault("anthropic-version", "2023-06-01")
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "application/json"
    headers.pop("accept-encoding", None)
    headers.pop("Accept-Encoding", None)
    headers["Authorization"] = f"Bearer {token}"
    headers["Content-Length"] = str(len(body))
    try:
        up = http.client.HTTPSConnection(UPSTREAM, timeout=60)
        up.request("POST", "/v1/messages?beta=true", body=body, headers=headers)
        resp = up.getresponse()
        resp.read()
        note_usage(name, resp)
        up.close()
        log(f"{name} refresh -> {resp.status}")
        return "ok" if resp.status < 400 or name in USAGE else f"http {resp.status}"
    except Exception as e:
        log(f"{name} refresh error {type(e).__name__}")
        return f"error {type(e).__name__}"


def refresh_all() -> dict:
    return {n: refresh_one(n, t) for n, t in load_tokens().items()}


def heartbeat(port: int) -> None:
    """Rewrite relay.alive every 10 s so the plugin can see the relay is up without an HTTP call."""

    def loop():
        while True:
            try:
                with open(ALIVE, "w", encoding="utf-8") as f:
                    f.write(json.dumps({"port": port, "pid": os.getpid(), "at": time.time(), "accounts": sorted(load_tokens().keys()), "expires": load_expiry(), "usage": dict(USAGE)}))
            except OSError:
                pass
            time.sleep(10)

    threading.Thread(target=loop, daemon=True).start()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    KEY = load_key()
    log(f"relay starting on 127.0.0.1:{port}")
    heartbeat(port)
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Relay).serve_forever()
    except OSError as e:  # port already held by a running relay: exit quietly
        log(f"relay exit: {e}")
        sys.exit(0)
