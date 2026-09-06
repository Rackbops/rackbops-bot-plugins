// The plugin's WoW config — the same values the bot resolved in src/config.ts, ported here with the
// identical defaults, validation, and error text. The bot resolves them from process.env into a
// `config` singleton at import; this plugin resolves them from `HostApi.env` in `initWowConfig`, which
// `createPlugin` calls once (synchronously, before any command or tick can fire). The ported modules
// (dmf/reset/realm/blizzard/transmog) read this `config` object exactly as they did in the bot — the
// only change to them was the import path — so keeping the export named `config` is what makes those
// ports byte-identical in logic. Reads are call-time, never at import, so the defaults below are all
// an un-initialized read (a module test that never calls initWowConfig) ever sees.
export type Region = "us" | "eu";

export interface WowConfig {
  region: Region;
  realmSlug?: string;
  blizzardClientId?: string;
  blizzardClientSecret?: string;
  dmfTimezone: string;
}

// A mutable singleton the ported modules read as `config.X`. Seeded with the bot's own "us" defaults so
// a call-time read before initWowConfig still gets a sane, valid value (the module tests rely on this).
export const config: WowConfig = {
  region: "us",
  dmfTimezone: "America/Los_Angeles",
};

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the WoW config from the plugin's declared env keys and populate the `config` singleton.
 * Pure apart from mutating that singleton — no I/O — so `createPlugin` stays pure and may THROW to
 * refuse an invalid value, with the exact error text the bot threw at boot (src/config.ts:77,105); the
 * host then skips just this plugin and logs the reason, booting core-only, per the warbandeer port.
 *
 * Mirrors the bot's `optional()`: an env var set to "" is treated as unset (see src/config.ts:63), so a
 * blank WOW_REALM/DMF_TIMEZONE falls back to its default exactly as it did in the bot.
 */
export function initWowConfig(env: Env): WowConfig {
  const optional = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v === "" ? undefined : v;
  };

  const region = (optional("WOW_REGION") ?? "us") as Region;
  if (region !== "us" && region !== "eu") {
    throw new Error(`WOW_REGION must be "us" or "eu", got "${region}"`);
  }

  // Validated here, not left to fail wherever dmf.ts first calls Intl.DateTimeFormat with it — an
  // invalid zone would otherwise throw on every scheduler tick. Same guard and text as the bot.
  const dmfTimezone =
    optional("DMF_TIMEZONE") ?? (region === "us" ? "America/Los_Angeles" : "Europe/Paris");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: dmfTimezone });
  } catch {
    throw new Error(`DMF_TIMEZONE is not a valid IANA time zone, got "${dmfTimezone}"`);
  }

  config.region = region;
  config.realmSlug = optional("WOW_REALM");
  config.blizzardClientId = optional("BLIZZARD_CLIENT_ID");
  config.blizzardClientSecret = optional("BLIZZARD_CLIENT_SECRET");
  config.dmfTimezone = dmfTimezone;
  return config;
}
