/** The actionable half of the `no-internal-credential` story — WHICH logins would let Clover's own
 *  background jobs run. A leaf constant so the log line (`internal-view.ts`) and the wire `problem`
 *  detail (`internal-router.ts`) are one sentence, never two that drift. Names the two doors a user
 *  actually has; never a secret name, never a value. */
export const INTERNAL_JOBS_LOGIN_HINT =
  "sign in with ChatGPT (Codex) or store an API key for a provider Clover can use (Settings › Providers, or `clover credentials set <provider>`)";
