// Env parsing, pure and separate so `config.test.ts` can pin exactly which values are rejected
// (invalid -> throw, so the host skips this plugin and logs why) versus merely absent (unset ->
// the feature is off and its command says so). That distinction is the authoring guide's rule 2.

export interface SpotifyAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The path component of `redirectUri` -- the only path the callback server answers on. */
  callbackPath: string;
}

export interface MusicConfig {
  setlistFmKey?: string;
  spotify?: SpotifyAppConfig;
  callbackPort?: number;
  /** Env keys that are missing, in the order a user should set them. Drives the "not configured" replies. */
  missing: string[];
}

/** A trimmed value, or undefined when the key is unset or blank -- the one rule every env key follows. */
export function present(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Resolves the plugin's five env keys.
 *
 * Throws only on a value that is SET but unusable -- a redirect URI that isn't a valid HTTPS URL,
 * carries credentials or a `#fragment`, or isn't written in the canonical form `new URL` would send
 * Spotify (the message names that form), a port that isn't plain digits in 1-65535. Spotify itself
 * refuses to register a non-HTTPS redirect (loopback aside, which cannot work here because the
 * browser completing the flow is not inside the container), so accepting one would only defer the
 * failure to the consent screen, where it is far harder to diagnose. A throw here makes the host skip
 * the whole plugin (all three commands), which is why each message says what to fix.
 *
 * An incomplete Spotify triple (id without secret, say) is NOT a throw: it is the ordinary
 * half-configured state an operator passes through while filling the panel in, so `spotify` stays
 * undefined and `missing` names what is still needed.
 */
export function resolveConfig(env: Readonly<Record<string, string | undefined>>): MusicConfig {
  const setlistFmKey = present(env.SETLISTFM_API_KEY);
  const clientId = present(env.SPOTIFY_CLIENT_ID);
  const clientSecret = present(env.SPOTIFY_CLIENT_SECRET);
  const redirectUriRaw = present(env.SPOTIFY_REDIRECT_URI);
  const portRaw = present(env.MUSIC_CALLBACK_PORT);

  let redirectUri: URL | undefined;
  if (redirectUriRaw !== undefined) {
    try {
      redirectUri = new URL(redirectUriRaw);
    } catch {
      throw new Error(`SPOTIFY_REDIRECT_URI must be a valid URL, got "${redirectUriRaw}"`);
    }
    if (redirectUri.protocol !== "https:") {
      throw new Error(`SPOTIFY_REDIRECT_URI must be an https:// URL, got "${redirectUriRaw}"`);
    }
    // The raw text is checked for `#` instead of `hash`: an EMPTY fragment (`.../cb#`) leaves `hash`
    // empty but survives in `toString()`, so the canonical-form check below would wave it through.
    // This message omits the raw value on purpose -- it can carry a password, and the host logs the
    // message. (The two checks above it, "valid URL" and "https", run first and still echo it.)
    if (redirectUri.username !== "" || redirectUri.password !== "" || redirectUriRaw.includes("#")) {
      throw new Error("SPOTIFY_REDIRECT_URI must not carry credentials or a #fragment");
    }
    // `redirectUri.toString()` is what `authorizeUrl` and `exchangeCode` send to Spotify, and `new URL`
    // rewrites what it is given (lower-cases the host, drops a default port, adds `/` to a bare host).
    // An operator who registered the un-rewritten form would be sent a string Spotify has never seen,
    // with the two looking identical at the consent screen -- so the configured value must already be
    // the sent one, and a value that is not is refused here with the form to use.
    if (redirectUri.toString() !== redirectUriRaw) {
      throw new Error(
        `SPOTIFY_REDIRECT_URI must be written exactly as it is sent to Spotify: use "${redirectUri.toString()}" (got "${redirectUriRaw}")`,
      );
    }
  }

  let callbackPort: number | undefined;
  if (portRaw !== undefined) {
    // Digits only: `Number()` alone would let `0x1F90`, `1e3`, `+80` and `8787.` through, none of which
    // the manifest's `format` accepts.
    const n = /^[0-9]+$/.test(portRaw) ? Number(portRaw) : Number.NaN;
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`MUSIC_CALLBACK_PORT must be a valid port number, got "${portRaw}"`);
    }
    callbackPort = n;
  }

  const missing: string[] = [];
  if (setlistFmKey === undefined) missing.push("SETLISTFM_API_KEY");
  if (clientId === undefined) missing.push("SPOTIFY_CLIENT_ID");
  if (clientSecret === undefined) missing.push("SPOTIFY_CLIENT_SECRET");
  if (redirectUri === undefined) missing.push("SPOTIFY_REDIRECT_URI");
  if (callbackPort === undefined) missing.push("MUSIC_CALLBACK_PORT");

  const config: MusicConfig = { missing };
  if (setlistFmKey !== undefined) config.setlistFmKey = setlistFmKey;
  if (clientId !== undefined && clientSecret !== undefined && redirectUri !== undefined) {
    config.spotify = {
      clientId,
      clientSecret,
      redirectUri: redirectUri.toString(),
      callbackPath: redirectUri.pathname,
    };
  }
  if (callbackPort !== undefined) config.callbackPort = callbackPort;
  return config;
}
