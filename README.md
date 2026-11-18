# claude-account-switcher

> **This fork (asif17r/claude-account-switcher)** adds, on top of SmelterLabs' original:
> - **Relay lock:** the relay makes a random secret (`relay.key`, mode 600) on first start and refuses any routed request or refresh without it, so other programs on the machine cannot spend your accounts.
> - **`/account refresh`:** sends each account one 1-token request so every account's 5-hour and weekly usage is fresh.
> - **`usage` button in the band:** fresh 5-hour and weekly usage for every account in a pop-up. The plugin is named `AS`, so the status line reads `AS 💳 WORK`.
> - **Compact status line:** `💳 PERSONAL · 5h 42% wk 61% · work 5h 8% wk 20%` (billed account first, then the others).
> - **One account for the whole machine:** a switch in any session (band button or `/account <name>`) is saved in `~/.claude/account-switcher/current` and every session, open or new, follows it: at its next message, and within about 5 seconds on its band and status line. Project marker files are no longer read.
> - **`scripts/check-accounts.sh`:** prints the organization id and usage behind each stored token, to catch a token approved under the wrong account.
> - **macOS tested** (Claude Desktop 5.11492.5, Claude Code 2.1.325, macOS 26, Apple silicon).
>
> New machine? Follow **[Setup on a new machine](#setup-on-a-new-machine-macos)** below.

Bill a Claude Code session to a different Claude subscription, per project or on demand, inside **one** Claude Desktop app or one terminal. No logout, no restart, no second copy of the app.

- One choice for the whole machine: switching in any session moves every session (open or new) to that account from its next message.
- A band above the prompt shows the account in force with one button per account that has a token: one click switches every session; `off` returns them all to the app's own login; `hide` puts the band away (remembered; `/account show` brings it back).
- `/account <name>` does the same by keyboard; `/account off` returns every session to the app's own login; `/account` shows status, token expiry and each account's real usage meters.
- The status line reads `💳 billing: WORK` whenever a session is routed. If the relay is down or has no token for the name, the session stays on the app's login and the status line says so.

| Platform | Installer | Service | Status |
|---|---|---|---|
| Windows | `scripts\install.ps1` | per-user scheduled task `ClaudeAccountRelay` | in daily use with Claude Desktop |
| Linux | `scripts/install.sh` | `systemd --user` unit `claude-account-relay.service` | tested end to end (Pop!_OS 24.04, Claude Code 2.1.281) |
| macOS | `scripts/install.sh` | LaunchAgent `com.claude-account-switcher.relay` | in daily use on this fork (Claude Desktop, Apple silicon) |

On Linux there is no Claude Desktop app, so the switcher there applies to terminal Claude Code only. On Windows and macOS it covers both the Desktop app's Code sessions and the terminal.

## Setup on a new machine (macOS)

Needs: Claude Desktop (or Claude Code 2.1.280+), Python 3.8+ (`/opt/homebrew/bin/python3` is preferred), git, and every account's own paid Claude subscription.

1. **Clone the fork:**
   ```bash
   git clone https://github.com/asif17r/claude-account-switcher.git ~/Documents/GitHub/claude-account-switcher
   cd ~/Documents/GitHub/claude-account-switcher
   ```
2. **Install** (copies plugin and relay to `~/.claude/account-switcher`, adds `CLAUDE_CODE_PLUGIN_DIRS` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` to `~/.claude/settings.json` with a backup, registers and starts the LaunchAgent; the relay creates `relay.key` itself):
   ```bash
   bash scripts/install.sh
   ```
   It ends with `Relay running: pid …, port 48620`. Run the scripts with `bash`: on some clones the execute bit is missing.
3. **Add each account, one at a time.** The approval page uses whatever account the *browser* is signed into and offers no picker, so:
   ```bash
   bash scripts/add-account.sh personal
   ```
   - If a browser opens on its own and is signed into the right account, approve there.
   - Otherwise close that tab, press `c` in the terminal to copy the link, open it in the browser (or a private window) signed into that account, approve, and paste the code back into the terminal.
   - Repeat with `bash scripts/add-account.sh work` for the other account.
4. **Check the tokens are really different accounts:**
   ```bash
   bash scripts/check-accounts.sh
   ```
   Each name must show a different `org`. Same org twice means one token was approved under the wrong account: rerun `add-account.sh <name>` for it (it replaces the old token).
5. **Load the plugin:** open a new session in the app (send any first message, then `/account`), or type `/reload-plugins` in an open one. The band above the prompt shows `💳 window account` with one button per account.
6. Optional: `/account refresh` fills in both accounts' usage.

The token from a wrong-account approval stays valid for a year; revoke it in that account's claude.ai settings if it lists it.

### When the 5-hour limit blocks the app

The app holds new messages while the signed-in account is at its limit, including `/account work`. Choose **send anyway** on the held `/account work` (or click **work** in the band), then **Try again**: the retry bills the other account.

### Which login decides what

- **Model calls:** the account you pick (`/account`, band button, or `.claude/account`), else the app's login.
- **Connectors, Remote Control, cloud routines, scheduled tasks, the app's usage panel:** the app's own login, never the relay's tokens (they are inference-only).
- **Organization policy** (for example Remote Control disabled by a Team admin): the Claude Code login stored in `~/.claude.json`, written by `claude` → `/login` in a terminal. If a work Team account is logged in there, its policy applies to every session. Log it into the account whose policy you want.

## How it works

Claude Desktop hands every Code session a login ticket for the account the app is signed into, and the engine keeps that ticket in memory, so environment tricks do not change it. What the engine *does* read per request is where to send the request (`ANTHROPIC_BASE_URL`). This project uses that:

1. **Relay** (`relay/relay.py`): a loopback-only HTTP relay on `127.0.0.1:48620`. A request to `/acct/<name>/<key>/v1/...` (the key from `relay.key`; anything else gets 403) is forwarded to `api.anthropic.com/v1/...` with the Authorization header replaced by `<name>`'s long-lived token. Responses stream back unchanged. It never logs a token.
2. **Plugin** (`plugin/`): a Claude Code hooks module that, when a marker or `/account` names an account, points the session at the relay path for that account and keeps the status line honest. It never reads a token; it learns which accounts exist, when their tokens expire and what their usage meters say from the relay's heartbeat file.
3. **Tokens** (`~/.claude/account-switcher/tokens.json`): one long-lived token per account from `claude setup-token` (one browser approval, valid one year, model requests only). Same protection level as Claude Code's own `.credentials.json`.

What stays on the app's own login: everything the app does itself (its panes, artifacts, scheduled tasks) and, inside a routed session, the claude.ai connector list, cloud routines and Remote Control, because the swapped ticket is model-only by design.

## Install

Requirements: Claude Code 2.1.280 or later (for `CLAUDE_CODE_PLUGIN_DIRS`), Python 3.8 or later (standard library only), and a Claude Pro/Max/Team/Enterprise subscription for every account you add.

### Windows (current user)

```powershell
git clone https://github.com/SmelterLabs/claude-account-switcher.git
.\claude-account-switcher\scripts\install.ps1
.\claude-account-switcher\scripts\add-account.ps1 -Name work     # browser opens: sign in as that account, approve
```

`install.ps1` copies the plugin and relay to `~/.claude/account-switcher`, adds `CLAUDE_CODE_PLUGIN_DIRS` to the `env` block of `~/.claude/settings.json` (backup kept), registers the per-user scheduled task `ClaudeAccountRelay` (starts at logon, 5-minute self-recovery) and starts it. Needs `pythonw.exe` on the PATH or in the default python.org location.

### Linux (tested) and macOS (untested)

```bash
git clone https://github.com/SmelterLabs/claude-account-switcher.git
./claude-account-switcher/scripts/install.sh
./claude-account-switcher/scripts/add-account.sh work        # browser opens or a sign-in URL is shown; approve
```

`install.sh` copies the plugin and relay to `~/.claude/account-switcher` (mode 700), adds `CLAUDE_CODE_PLUGIN_DIRS` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` to the `env` block of `~/.claude/settings.json` (backup kept), registers the relay as a per-user service that starts at login and restarts on failure, starts it and checks the heartbeat:

- Linux: `~/.config/systemd/user/claude-account-relay.service`, enabled for `default.target`. On a headless box that should relay without anyone logged in, run `loginctl enable-linger $USER` once.
- macOS: `~/Library/LaunchAgents/com.claude-account-switcher.relay.plist`, loaded with `launchctl bootstrap gui/<uid>` (falls back to `launchctl load -w`). Python 3 from Homebrew or python.org is preferred over the Xcode stub.

`add-account.sh` runs `claude setup-token` inside a pseudo-terminal (it prints nothing without one), passes your keystrokes through in case Claude Code asks you to paste a code, shows its screen with the token masked, and writes the token straight into `tokens.json` (mode 600).

Open a new Claude Code session afterwards; existing sessions do not load the plugin.

## Use

- In any session (the choice applies to all of them): click an account in the band above the prompt, or `/account`, `/account work`, `/account off`, `/account refresh`, `/account hide`, `/account show`.
- Renew a token near expiry (the status line warns at 14 days): run add-account for that name again.
- Remove: `scripts\uninstall.ps1` / `scripts/uninstall.sh` (`-PurgeTokens` / `--purge-tokens` to delete the token store too).

## Limits and notes

- A routed session's rate-limit meters (`/account`) are the routed account's. The app's own usage tray still shows the app's login.
- Hooks-module plugins are early access in the terminal CLI: the terminal needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, which `install.sh` sets in `settings.json`. Claude Desktop sets it for its own sessions, so `install.ps1` does not.
- Switching a chat to another account makes its next message miss the prompt cache (cache is per account), so that one message re-reads the whole chat. `/compact` first if the chat is long.
- A chat billed to a company Team account becomes that organization's data, and shows in its admin usage under your name.

## Terms

Every token comes from Anthropic's own `claude setup-token` flow, approved in a browser by the account owner, and every account is that user's own paid Claude subscription. The relay only swaps which of *your* subscriptions a session bills; sharing tokens with other people or machines is outside what this tool is for and may breach Anthropic's terms. Check the terms that apply to your plan before using it.

See `TECHNICAL-GUIDE.md` for the full design, what was tried and rejected, and the evidence; `USER-GUIDE.md` for the plain-language version.
