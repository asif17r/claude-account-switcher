# claude-account-switcher — User Guide

One Claude Desktop app (or one terminal), several Claude subscriptions. You keep the app signed into one account; projects (or a command) decide which account actually pays for a session's model calls.

Works on Windows and macOS with the Claude Desktop app and with terminal Claude Code. On Linux there is no Claude Desktop app, so it applies to terminal Claude Code only. This fork is in daily use on macOS. Installing on a new machine: see "Setup on a new machine" in README.md.

## Everyday use

**Pin a project to an account.** Put a file named `account` inside the project's `.claude` folder containing just the account's name, for example `work`. Every session you open in that project then bills that account. The status line under the prompt shows `💳 WORK`.

**Switch one session with a click.** Above the prompt box there is a slim row: 💳 the account this session bills, then one button per account you have added. Click one and that session bills it from your next message on; the row and the status line both change. `off` puts it back on the app's own account. `hide` removes the row in every session (your choice is remembered); `/account show` brings it back. After installing or updating the plugin, a session that is already open needs `/reload-plugins` once before the row appears; new sessions have it from the start.

**Or by keyboard.** Type `/account work` in the session; from your next message on, that session bills the `work` account. `/account off` puts it back on the app's own account. `/account` on its own tells you what the session is doing, whether the relay is up, which accounts have tokens, when each token expires, and each account's real usage (5-hour and weekly, with reset times).

**Where to read usage.** Use `/account`, or `/account refresh` to get fresh 5-hour and weekly numbers for every account (it sends each one a 1-token request; on an account with no 5-hour window running, that starts one). The status line also shows them. The app's own usage panel, and a session asked "what's my usage", report the account the app is signed into, not the account a switched session is billing.

**Nothing set?** The session just uses the account the app is signed into, exactly as before.

## What the status line means

| Status line | Meaning |
|---|---|
| `💳 WORK · 5h 8% wk 20% · personal 5h 42% wk 61%` | This session's model calls go to the `work` account; then its usage, then the other accounts'. |
| `💳 WORK ⚠ token expires in 9d` | Same, and that token needs renewing soon (see below). |
| `💳 window account · personal 5h 42% wk 61%` | Not routed: the app's own account; usage of accounts seen so far. |
| `⚠ WORK: relay down · billing window account` | The relay isn't running, so the session fell back to the app's account. Start it (see below) or log off and on. |
| `⚠ WORK: no token · billing window account` | No token stored for that name. Add one (see below). |
| (nothing) | The session is on the app's account and no usage has been read yet. |

Starting the relay by hand:

| Platform | Command |
|---|---|
| Windows | `Start-ScheduledTask ClaudeAccountRelay` |
| Linux | `systemctl --user start claude-account-relay` |
| macOS | `launchctl kickstart gui/$(id -u)/com.claude-account-switcher.relay` |

## Adding or renewing an account

Tokens last one year. To add one, or renew one that's about to expire:

1. In your normal browser, make sure claude.ai is signed in as the account you're adding (sign out and back in if needed; the approval page does not offer a picker).
2. Run, from the folder you cloned the project into:
   - Windows (PowerShell): `scripts\add-account.ps1 -Name work`
   - macOS / Linux: `bash scripts/add-account.sh work`. If the browser that opens is the wrong account, press `c` to copy the link and open it in the right browser or a private window.
3. A browser tab opens (on a machine without a browser, a sign-in link is printed); approve. If Claude Code asks you to paste a code, paste it into the same terminal. The token is saved directly; on screen it is masked.

Then run `bash scripts/check-accounts.sh` (macOS / Linux): each name must show a different organization id.

Account names are lowercase, short, and yours to choose (`work`, `personal`, `team`). The name in a project's `.claude/account` file must match.

## Things to know

- The app's own usage tray shows the app's account; `/account` in a routed session shows the account it's billing.
- Inside a routed session, claude.ai connectors, cloud routines and Remote Control aren't available (the swapped login is model-only). Everything else works as normal.
- The relay only listens on your own machine (127.0.0.1); nothing is reachable from the network. It also needs its secret key (`relay.key`), so other programs on your machine cannot use it.
- At a 5-hour limit the app holds new messages: choose **send anyway** on a held `/account <other>` (or click the other account in the band), then **Try again**.
- Every token is one of your own subscriptions, approved by you through Anthropic's own sign-in. Don't share tokens with other people or machines.
- To remove everything: `scripts\uninstall.ps1` on Windows, `scripts/uninstall.sh` on macOS/Linux (add `-PurgeTokens` / `--purge-tokens` to delete the stored tokens too).
