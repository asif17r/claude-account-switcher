// account-switcher — bill a Claude Code session to a different Claude subscription.
//
// How it works: the relay (relay.py, loopback only) rewrites the Authorization header for the
// account named in the request path. This plugin points the session's API traffic at
// http://127.0.0.1:48620/acct/<name>. The account is one choice for the whole machine, kept in
// the file `current` beside the relay: `/account <name>` or a button in the band above the prompt
// writes it, and every session (open or new) reads it before each message and every few seconds,
// so a switch in one session moves all of them. The desktop app keeps its own login; only the
// sessions' model requests change accounts. Fails open:
// relay down or no token → the session stays on the window's account and the status line says
// so. The plugin never reads or logs a token; expiry dates come from the relay's heartbeat file.
// Every routed request carries the relay's secret key (relay.key, beside the relay) in its path,
// so other local programs cannot spend the accounts through the relay.

import { atom, read, update } from "claude-code";
import type { Billing } from "../types";

const RELAY = "http://127.0.0.1:48620";
const STALE_S = 30;
const WARN_DAYS = 14;
const HIDDEN_KEY = "band.hidden"; // $.store: the hide choice outlives the session
const POLL_MS = 5000;             // how often an open session looks for a switch made elsewhere

type Usage = { at: number; h5: number | null; h5_reset: number | null; d7: number | null; d7_reset: number | null };
type Heartbeat = { port: number; pid: number; at: number; accounts: string[]; expires?: Record<string, string>; usage?: Record<string, Usage> };

// What the band draws from. Held by the host, so a hot reload keeps the chosen account.
const billing = atom({ plugin: "AS", key: "billing" } as const, {
  account: null, source: null, accounts: [], relayUp: false, host: null,
} as Billing);
const isHidden = atom({ plugin: "AS", key: "isHidden" } as const, false);

// The routed account's own usage, as the API reported it on that account's last reply through the relay.
// The desktop app's usage readout is the window's login, not this.
function usageLine(name: string, u?: Usage): string | null {
  if (!u) return null;
  const pct = (v: number | null) => (v === null ? "?" : `${Math.round(v * 100)}%`);
  const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "?");
  const age = Math.max(0, Math.round((Date.now() / 1000 - u.at) / 60));
  return `  ${name} usage: 5-hour ${pct(u.h5)} (resets ${when(u.h5_reset)}) · weekly ${pct(u.d7)} (resets ${when(u.d7_reset)}) · seen ${age} min ago`;
}

let store = "";
let relayKey = "";
let hb: Heartbeat | null = null;
let warned = false;
// A session starts on the app's own login and is routed from its first message on. Remote
// Control refuses a session whose ANTHROPIC_BASE_URL is not api.anthropic.com, so this lets it
// connect at startup on the host's login; the relay takes over the model calls afterwards.
let routing = false;

function dir(p: string): string { return p.replace(/[\\/][^\\/]+[\\/]?$/, ""); }

async function readHeartbeat($: any): Promise<Heartbeat | null> {
  try {
    const f = `${store}/relay.alive`;
    if (!(await $.fs.exists(f))) return null;
    const h = JSON.parse(await $.fs.read(f)) as Heartbeat;
    return (Date.now() / 1000 - Number(h.at ?? 0)) < STALE_S ? h : null;
  } catch { return null; }
}

async function readKey($: any): Promise<string> {
  try {
    const f = `${store}/relay.key`;
    if (!(await $.fs.exists(f))) return "";
    return (await $.fs.read(f)).trim();
  } catch { return ""; }
}

// Usage readout for the billed account only, e.g. "5h 42% wk 61%". Empty when no account is
// routed (the window account's usage is in the app's own usage panel) or none has been seen yet.
function usageSummary(h: Heartbeat | null, current: string | null): string {
  const u = current ? h?.usage?.[current] : undefined;
  if (!u) return "";
  const pct = (v: number | null) => (v === null ? "?" : `${Math.round(v * 100)}%`);
  return `5h ${pct(u.h5)} wk ${pct(u.d7)}`;
}

// The machine-wide choice: the account name in `current` beside the relay, or null (missing or
// empty file) for the window's own account.
async function readCurrent($: any): Promise<string | null> {
  try {
    const f = `${store}/current`;
    if (!(await $.fs.exists(f))) return null;
    return (await $.fs.read(f)).trim().toLowerCase() || null;
  } catch { return null; }
}

async function writeCurrent($: any, account: string | null): Promise<void> {
  await $.fs.write(`${store}/current`, account ? `${account}\n` : "");
}

function daysLeft(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : null;
}

// Point the session's API traffic where the chosen account says, update the band's state and
// the status line, and return the one-line summary. Never called while drawing.
async function apply($: any, account: string | null, source: Billing["source"]): Promise<string> {
  const b = await read($, billing);
  const host = b.host ?? { baseUrl: await $.env.get("ANTHROPIC_BASE_URL") };
  hb = await readHeartbeat($);
  relayKey = await readKey($);
  if (!relayKey) hb = null;            // no key: the relay cannot be used, treat it as down
  const accounts = hb?.accounts ?? [];
  const meters = usageSummary(hb, account);
  const set = (patch: Partial<Billing>) => update($, billing, (cur) => ({ ...cur, host, accounts, relayUp: !!hb, ...patch }));

  if (!account) {
    await $.env.set("ANTHROPIC_BASE_URL", host.baseUrl);
    await set({ account: null, source: null });
    $.ui.status(meters ? `💳 window account · ${meters}` : "💳 window account");
    return "billing: window account";
  }
  const label = account.toUpperCase();
  if (!hb) {
    await $.env.set("ANTHROPIC_BASE_URL", host.baseUrl);
    await set({ account, source });
    const s = `⚠ ${label}: relay down · billing window account`;
    $.ui.status(s); return s;
  }
  if (!accounts.includes(account)) {
    await $.env.set("ANTHROPIC_BASE_URL", host.baseUrl);
    await set({ account, source });
    const s = `⚠ ${label}: no token · billing window account`;
    $.ui.status(s); return s;
  }
  await $.env.set("ANTHROPIC_BASE_URL", routing ? `${RELAY}/acct/${account}/${relayKey}` : host.baseUrl);
  await set({ account, source });
  const left = daysLeft(hb.expires?.[account]);
  let s = `💳 ${label}`;
  if (left !== null && left <= WARN_DAYS) {
    s += ` ⚠ token expires in ${left}d`;
    if (!warned) { warned = true; $.ui.toast(`account-switcher: the ${label} token expires in ${left} days — run the add-account script for ${account} again`); }
  }
  if (meters) s += ` · ${meters}`;
  $.ui.status(s);
  return s;
}

// Follow the machine-wide choice (written by this or any other session).
async function reapply($: any): Promise<string> {
  const current = await readCurrent($);
  return apply($, current, current ? "machine" : null);
}

// Switch every session: record the choice, then apply it here at once.
async function choose($: any, account: string | null): Promise<string> {
  await writeCurrent($, account);
  return apply($, account, account ? "machine" : null);
}

async function setHidden($: any, hidden: boolean): Promise<void> {
  await update($, isHidden, () => hidden);
  await $.store.set(HIDDEN_KEY, hidden);
}

// Fresh usage for every account: the relay sends each one a 1-token request and returns their
// usage windows. One line per account, or the reason it could not.
async function refreshUsage($: any): Promise<{ ok: boolean; lines: string[] }> {
  hb = await readHeartbeat($);
  relayKey = await readKey($);
  if (!hb || !relayKey) return { ok: false, lines: ["Relay is down or has no key; cannot refresh usage."] };
  try {
    const r = await $.http.fetch(`${RELAY}/refresh/${relayKey}`, { method: "POST" });
    if (!r.ok) return { ok: false, lines: [`Refresh failed: HTTP ${r.status}`] };
    const out = JSON.parse(r.text) as { results: Record<string, string>; usage: Record<string, Usage> };
    const lines = Object.keys(out.results).map((n) => usageLine(n, out.usage?.[n]) ?? `  ${n}: ${out.results[n]}`);
    await reapply($);
    return { ok: true, lines };
  } catch (err) {
    return { ok: false, lines: [`Refresh failed: ${String(err)}`] };
  }
}

export function register(on: any) {
  on("session.start", async ($: any, e: any, next: any) => {
    store = dir($.plugin.root);
    const hidden = (await $.store.get(HIDDEN_KEY)) === true;
    await update($, isHidden, () => hidden);
    await reapply($);
    // Pick up a switch made in another session while this one sits idle, so its band and
    // status line stay in step. Only a change is applied.
    // Best effort: without a clock the session still follows at its next message.
    try {
      $.clock.every(POLL_MS, async () => {
        const b = await read($, billing);
        if ((await readCurrent($)) !== b.account) await reapply($);
      });
    } catch { /* no clock here */ }
    await $.command.register({
      name: "account",
      description: "Bill this session to another Claude account (via the account-switcher relay)",
      argumentHint: "[name | off | status | refresh | show | hide]",
    });
    return next(e);
  });

  on("turn.start", async ($: any, e: any, next: any) => { routing = true; await reapply($); return next(e); });
  on("prompt.submit", async ($: any, e: any, next: any) => { routing = true; await reapply($); return next(e); });

  // The band above the prompt: the account in force and one button per account the relay has a
  // token for, plus a usage button. Hidden by its own button (remembered across sessions); `/account show` brings it back.
  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: any) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e);
    const b = await read($, billing);
    const { Box, Button, Text } = $.ui.resolve(e);
    const current = b.account ? b.account.toUpperCase() : "window account";
    const pick = (name: string | null) => async () => {
      const s = await choose($, name);
      $.ui.toast(`account-switcher: ${s}. Every session uses it from its next message.`);
    };
    // Fresh 5-hour and weekly usage for every account, shown in a toast.
    const showUsage = async () => {
      const u = await refreshUsage($);
      $.ui.toast(u.lines.map((l) => l.trim()).join("\n"), { timeoutMs: 15000 });
    };
    return (
      <Box flexDirection="row" gap={1}>
        <Text>💳 {current}</Text>
        {b.relayUp
          ? b.accounts.map((name) => (
              <Button key={`acct:${name}`} label={name} variant={name === b.account ? "primary" : "secondary"} onPress={pick(name)} />
            ))
          : <Text dimColor>relay down</Text>}
        {b.account && <Button key="acct:off" label="off" dimColor onPress={pick(null)} />}
        {b.relayUp && <Button key="usage" label="usage" dimColor onPress={showUsage} />}
        <Button key="hide" label="hide" dimColor onPress={() => setHidden($, true)} />
      </Box>
    );
  });

  on("command.run", { command: "account" }, async ($: any, e: any) => {
    const arg = (e.args ?? "").trim().toLowerCase();
    hb = await readHeartbeat($);
    const known = hb?.accounts ?? [];
    const b = await read($, billing);
    if (!arg || arg === "status") {
      const lines = [
        b.account ? `All sessions bill: ${b.account.toUpperCase()}` : "All sessions bill: the window's own account",
        hb ? `Relay: up (pid ${hb.pid}, port ${hb.port}); accounts with tokens: ${known.join(", ") || "none"}` : "Relay: DOWN — sessions fall back to the window's account",
      ];
      for (const n of known) { const d = daysLeft(hb?.expires?.[n]); if (d !== null) lines.push(`  ${n}: token expires in ${d} days`); }
      for (const n of known) { const u = usageLine(n, hb?.usage?.[n]); if (u) lines.push(u); }
      if (hb && !Object.keys(hb.usage ?? {}).length) lines.push("  usage: none seen yet (appears after an account's first reply through the relay)");
      lines.push(`Band above the prompt: ${(await read($, isHidden)) ? "hidden (/account show)" : "shown (/account hide)"}`);
      lines.push("Usage: /account <name> · /account off · /account refresh (fresh usage for every account). A switch applies to every session on this machine.");
      return { text: lines.join("\n") };
    }
    if (arg === "refresh") {
      const u = await refreshUsage($);
      return { text: (u.ok ? ["Usage refreshed (each account sent one tiny request):", ...u.lines] : u.lines).join("\n") };
    }
    if (arg === "show" || arg === "hide") {
      await setHidden($, arg === "hide");
      return { text: arg === "hide" ? "Band hidden in every session; /account show brings it back." : "Band shown above the prompt." };
    }
    if (arg === "off") {
      return { text: `${await choose($, null)}. Every session uses it from its next message.` };
    }
    if (!known.includes(arg)) {
      return { text: hb ? `No token for '${arg}'. Known: ${known.join(", ") || "none"}. Add one with scripts/add-account.ps1 -Name ${arg} (Windows) or scripts/add-account.sh ${arg} (macOS/Linux)` : "Relay is down; start it (Windows: scheduled task ClaudeAccountRelay · Linux: systemctl --user start claude-account-relay · macOS: launchctl kickstart gui/$(id -u)/com.claude-account-switcher.relay) and try again." };
    }
    return { text: `${await choose($, arg)}. Every session uses it from its next message.` };
  });
}
