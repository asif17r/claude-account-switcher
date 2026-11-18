// The values the account-switcher band draws from, held by the host for the session
// (a hot reload keeps them; the module's own variables start over).
export type Billing = {
  /** The account this session bills (the machine-wide choice), or null for the window's own login. */
  account: string | null;
  /** How the account was chosen: "machine" is the shared `current` file beside the relay. */
  source: "machine" | null;
  /** Accounts the relay holds a token for; empty while the relay is down. */
  accounts: string[];
  /** Whether the relay answered a fresh heartbeat. */
  relayUp: boolean;
  /** ANTHROPIC_BASE_URL as the host set it, captured once per session and restored by "off". */
  host: { baseUrl: string | undefined } | null;
};

declare module "claude-code" {
  interface PluginState {
    "AS": { billing: Billing; isHidden: boolean };
  }
}
