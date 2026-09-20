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

function present(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Resolves the plugin's five env keys.
 *
 * Throws only on a value that is SET but unusable -- a redirect URI that isn't a valid HTTPS URL, a
 * port outside 1-65535. Spotify itself refuses to register a non-HTTPS redirect (loopback aside,
 * which cannot work here because the browser completing the flow is not inside the container), so
 * accepting one would only defer the failure to the consent screen, where it is far harder to
 * diagnose.
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
  }

  let callbackPort: number | undefined;
  if (portRaw !== undefined) {
    const n = Number(portRaw);
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
