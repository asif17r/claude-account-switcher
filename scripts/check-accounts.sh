#!/usr/bin/env bash
# Shows which Claude organization each stored token belongs to, and its usage, by sending each one
# tiny model request (1 output token) straight to api.anthropic.com. Use it after add-account.sh to
# catch the common mistake of approving the token while the browser was signed into the wrong
# account: two names that print the same organization id are the same account.
# Usage: scripts/check-accounts.sh [--store DIR]
set -euo pipefail
STORE="$HOME/.claude/account-switcher"
[ "${1:-}" = "--store" ] && STORE="$2"
python3 -I - "$STORE/tokens.json" <<'PY'
import http.client, json, sys
tokens = json.load(open(sys.argv[1]))
body = json.dumps({"model": "claude-haiku-5-5", "max_tokens": 1,
                   "system": "You are Claude Code, Anthropic's official CLI for Claude.",
                   "messages": [{"role": "user", "content": "ok"}]})
pct = lambda v: "?" if v is None else f"{round(float(v) * 100)}%"
for name, entry in tokens.items():
    token = entry["token"] if isinstance(entry, dict) else entry
    c = http.client.HTTPSConnection("api.anthropic.com", timeout=60)
    c.request("POST", "/v1/messages?beta=true", body=body, headers={
        "Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json"})
    r = c.getresponse(); r.read()
    h = lambda k: r.getheader("anthropic-ratelimit-unified-" + k)
    print(f"{name:12} HTTP {r.status}  org {r.getheader('anthropic-organization-id')}  "
          f"5h {pct(h('5h-utilization'))}  week {pct(h('7d-utilization'))}")
PY
