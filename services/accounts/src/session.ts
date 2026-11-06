// Who is signed in: the caller's Supabase access token, checked with waifucave's Supabase project itself
// (GET /auth/v1/user). Asking the project, rather than checking the JWT here, works whichever way the project signs
// its tokens and refuses a session that was signed out. Nothing of the token or of the answer is logged or kept.

import { fetchableUrl } from "../../shared/web";
import { ACCOUNT_RE } from "./wire";

export interface AuthEnv {
  /** The Supabase project's URL. */
  AUTH_URL: string;
  /** The project's public (anon) key, which Supabase wants beside a user's token. */
  AUTH_ANON_KEY: string;
}

export type Session = { account: string } | { refused: true } | { unavailable: true };

const TIMEOUT_MS = 5_000;
const MAX_ANSWER_BYTES = 64 * 1024;

export async function sessionOf(accessToken: string, env: AuthEnv, fetcher: typeof fetch = fetch): Promise<Session> {
  if (!env.AUTH_URL || !fetchableUrl(env.AUTH_URL) || !env.AUTH_ANON_KEY) return { unavailable: true };
  let response: Response;
  try {
    response = await fetcher(`${env.AUTH_URL.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: env.AUTH_ANON_KEY, authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { unavailable: true };
  }
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return { refused: true };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { unavailable: true };
  }
  let user: { id?: unknown; is_anonymous?: unknown };
  try {
    const text = await response.text();
    if (text.length > MAX_ANSWER_BYTES) return { unavailable: true };
    user = JSON.parse(text) as typeof user;
  } catch {
    return { unavailable: true };
  }
  // An anonymous Supabase sign-in is not a waifucave account.
  if (typeof user.id !== "string" || !ACCOUNT_RE.test(user.id) || user.is_anonymous === true) return { refused: true };
  return { account: user.id };
}
