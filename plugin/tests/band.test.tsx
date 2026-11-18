// The band above the prompt: one button per account the relay has a token for. A press records the
// choice for the whole machine (the `current` file beside the relay) and moves this session's API
// traffic to that account; every other session follows it. "off" moves all of them back, and
// "hide" is remembered in the store.
import { test, expect, mock } from "claude-code/testing";

const RELAY = "http://127.0.0.1:48620";
const KEY = "test-key";
const BAND = { plugin: "AS", component: "AbovePrompt" as const, props: { hasSurvey: false, isWorking: false, maxRows: 10 } };

// The world beneath the plugin: a clock, an in-memory file system holding the relay's heartbeat
// and key (matched by file name, whatever the plugin's root), and an environment the plugin may
// write (the kit's mock.env is read-only).
function world(on: any, up: boolean, env: Record<string, string | undefined>, files: Record<string, string> = {}) {
  const clock = mock.clock(on);
  const name = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
  const fs: Record<string, string> = { "relay.key": KEY, ...files };
  // A fresh heartbeat: the plugin judges its age by the real time, not the mocked clock.
  if (up) fs["relay.alive"] = JSON.stringify({ port: 48620, pid: 1, at: Date.now() / 1000, accounts: ["vbp", "personal2", "personal"] });
  on("fs.exists", async (_$: any, e: any) => ({ value: name(e.path) in fs }));
  on("fs.read", async (_$: any, e: any) => (name(e.path) in fs ? { value: fs[name(e.path)] } : { deny: `unexpected read ${e.path}` }));
  on("fs.write", async (_$: any, e: any) => { fs[name(e.path)] = e.text; return { value: undefined }; });
  on("session.cwd", async () => ({ value: "C:/work/project" }));
  on("session.root", async () => ({ value: "C:/work/project" }));
  on("session.start", async (_$: any, e: any) => ({ cwd: e.cwd }));
  on("prompt.submit", async (_$: any, e: any) => ({ text: e.text }));
  on("env.get", async (_$: any, e: any) => ({ value: env[e.name] }));
  on("env.set", async (_$: any, e: any) => { env[e.name] = e.value; return { value: undefined }; });
  on("ui.status", async () => ({ value: undefined }));
  const toasts: string[] = [];
  on("ui.toast", async (_$: any, e: any) => { toasts.push(e.text); return { value: undefined }; });
  on("command.register", async (_$: any, e: any) => ({ value: { command: e.name } }));
  // The engine's own band is empty: what a hidden band's next(e) reaches.
  on("ui.render", { component: "AbovePrompt" }, async () => ({ type: "Box", props: {}, children: [] }));
  return { env, fs, clock, toasts };
}

for (const surface of ["terminal", "desktop"] as const) {
  test(`a button press switches the machine-wide account and off restores the host URL (${surface})`, async ($, on) => {
    mock.store(on);
    const { env, fs } = world(on, true, { ANTHROPIC_BASE_URL: "https://host.example" });
    await $.session.start({ cwd: "C:/work/project", surface, isInteractive: true });
    await $.prompt.submit({ text: "hi" }); // routing starts with the first message

    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ key: "acct:vbp" })).toBeDefined();
    expect(await ui.find({ key: "acct:personal2" })).toBeDefined();
    expect(await ui.find({ key: "acct:off" })).toBeUndefined(); // nothing to turn off yet
    expect(await ui.find({ type: "Text", text: /window account/ })).toBeDefined();

    await ui.press({ key: "acct:personal2" });
    expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/personal2/${KEY}`);
    expect(fs.current.trim()).toBe("personal2");
    expect(await ui.find({ type: "Text", text: /PERSONAL2/ })).toBeDefined();
    expect(await ui.find({ key: "acct:off" })).toBeDefined();

    await ui.press({ key: "acct:off" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
    expect(fs.current).toBe("");
    expect(await ui.find({ key: "acct:off" })).toBeUndefined();

    await ui.press({ key: "hide" });
    expect(await ui.find({ key: "acct:vbp" })).toBeUndefined();
    await ui.unmount();
  });
}

test("a new session starts on the machine-wide account another session chose", async ($, on) => {
  mock.store(on);
  const { env } = world(on, true, { ANTHROPIC_BASE_URL: "https://host.example" }, { current: "personal\n" });
  await $.session.start({ cwd: "C:/elsewhere", surface: "desktop", isInteractive: true });
  // Startup stays on the host's login so Remote Control can connect; the first message routes.
  expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
  await $.prompt.submit({ text: "hi" });
  expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/personal/${KEY}`);
  const { text } = await $.command.run({ command: "account", args: "" });
  expect(text).toMatch(/All sessions bill: PERSONAL/);
});

test("an idle open session follows a switch made elsewhere within a few seconds", async ($, on) => {
  mock.store(on);
  const { env, fs, clock } = world(on, true, { ANTHROPIC_BASE_URL: "https://host.example" });
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  await $.prompt.submit({ text: "hi" }); // routing starts with the first message
  expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example"); // nothing chosen yet
  fs.current = "vbp\n"; // another session pressed vbp
  await clock.advance(6000);
  expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/vbp/${KEY}`);
});

test("/account <name> records the choice for every session", async ($, on) => {
  mock.store(on);
  const { env, fs } = world(on, true, { ANTHROPIC_BASE_URL: "https://host.example" });
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  await $.prompt.submit({ text: "hi" }); // routing starts with the first message
  const { text } = await $.command.run({ command: "account", args: "personal" });
  expect(text).toMatch(/Every session/);
  expect(fs.current.trim()).toBe("personal");
  expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/personal/${KEY}`);
});

test("relay down: no account buttons, the band says so, and the session keeps the host URL", async ($, on) => {
  mock.store(on);
  const { env } = world(on, false, { ANTHROPIC_BASE_URL: "https://host.example" }, { current: "personal\n" });
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  await $.prompt.submit({ text: "hi" }); // routing starts with the first message
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ key: "acct:vbp" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /relay down/ })).toBeDefined();
  expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
  await ui.unmount();
});

test("a hide remembered in the store keeps the band away; /account show brings it back", async ($, on) => {
  mock.store(on, { "band.hidden": true });
  world(on, true, {});
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  await $.prompt.submit({ text: "hi" }); // routing starts with the first message
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ key: "acct:vbp" })).toBeUndefined();
  const { text } = await $.command.run({ command: "account", args: "show" });
  expect(text).toMatch(/shown/);
  expect(await ui.find({ key: "acct:vbp" })).toBeDefined();
  await ui.unmount();
});

test("the usage button refreshes every account and shows their usage in a toast", async ($, on) => {
  mock.store(on);
  const { toasts } = world(on, true, {});
  on("http.fetch", async (_$: any, e: any) => {
    expect(e.url).toBe(`${RELAY}/refresh/${KEY}`);
    const w = { at: Date.now() / 1000, h5: 0.27, h5_reset: null, d7: 0.05, d7_reset: null };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ results: { personal: "ok", vbp: "ok" }, usage: { personal: w, vbp: { ...w, h5: 0.46, d7: 0.9 } } }) } };
  });
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  await $.prompt.submit({ text: "hi" }); // routing starts with the first message
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });
  await ui.press({ key: "usage" });
  const last = toasts[toasts.length - 1];
  expect(last).toMatch(/personal usage: 5-hour 27%.*weekly 5%/);
  expect(last).toMatch(/vbp usage: 5-hour 46%.*weekly 90%/);
  await ui.unmount();
});
