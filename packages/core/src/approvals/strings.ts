// What a card and a saved rule do with strings that come from a model or a plugin (#267's review, items 4 and 5).
//   * Characters that hide or reorder text (controls, bidi overrides and isolates, zero-width marks) never reach a
//     card: a name, a path or a device name loses them (`plainOf`); a command or a call's input, which the person
//     approves as it runs, shows each one as a visible `\u{…}` escape instead (`shownCode`), so nothing in it is
//     hidden and nothing reorders what is around it.
//   * A command that looks like it carries a credential is never offered "always" (`looksCredentialBearing`), and a
//     saved rule keeps only a hash of its key and a scrubbed display string (`ruleKeyHash`, `ruleDisplay`), never
//     the raw command.
import { createHash } from "node:crypto";

/** C0 and C1 controls but tab and newline, the bidi marks, embeddings, overrides and isolates, and zero-width and
 *  invisible joiners and separators. */
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
const UNSAFE_OR_SPACE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/** A single-line name (a non-built-in tool, a path, a device): the hiding characters, tabs and newlines removed. */
export function plainOf(s: string): string {
  return s.replace(UNSAFE_OR_SPACE, "");
}

/** A command or a call's input as a card shows it: every hiding character as a visible escape. */
export function shownCode(s: string): string {
  return s.replace(UNSAFE, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** Programs that take a password after `-p`, where `-p <word>` is a credential (elsewhere `-p` is a port, a parent
 *  folder, a patch: `mkdir -p` keeps its "always"). */
const PASSWORD_P = /(?:^|[\s;&|(`])(?:\S*\/)?(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mariadb|mariadb-dump|mariadb-admin|sshpass|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport|smbclient|ldapsearch|ldapmodify|ldapadd)\b[^;&|]*?\s-p\s*\S/i;

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // An auth header, a cookie, a bearer or basic credential.
  /\b(?:proxy-)?authorization\s*:/i,
  /\b(?:x-)?api[-_]?key\s*:/i,
  /\b(?:cookie|set-cookie|x-auth-token|x-access-token|private-token)\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bbasic\s+[A-Za-z0-9+/]{8,}={0,2}/i,
  // A query parameter, an environment assignment or an option whose name says token, key, secret or password.
  /[?&;\s"'`(]-{0,2}[A-Za-z0-9_.-]*(?:token|key|secret|passw(?:or)?d|pwd|passwd|credential|auth|sig|signature)s?=\S/i,
  /^[A-Za-z0-9_.-]*(?:token|key|secret|passw(?:or)?d|pwd|credential)s?=\S/i,
  // A password option, and a password on a URL or curl's `-u user:password`.
  /(?:^|\s)--?(?:password|passwd|pass)(?:[=\s]|$)/i,
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/,
  /(?:^|\s)(?:-u|--user)\s*[^\s:]+:\S+/,
  // Well-known token shapes.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** A long hex run (32 or more, letters and digits both). */
const HEX_RUN = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
/** A long base64 or base64url run: 24 or more between slashes (a path's folders are what slashes split), with upper
 *  case, lower case and digits mixed as random text has them. */
const B64_RUN = /[A-Za-z0-9+_-]{24,}={0,2}/g;

function randomLooking(run: string): boolean {
  let upper = 0, lower = 0, digit = 0;
  for (const c of run) {
    if (c >= "A" && c <= "Z") upper++;
    else if (c >= "a" && c <= "z") lower++;
    else if (c >= "0" && c <= "9") digit++;
  }
  return upper >= 4 && lower >= 4 && digit >= 2;
}

/** Whether `s` looks like it carries a credential: an auth header, a `token=` or `key=` parameter, a password option,
 *  a password in a URL, a known token shape, or a long hex or base64 run. Erring toward yes costs only the "always". */
export function looksCredentialBearing(s: string): boolean {
  if (CREDENTIAL_SHAPES.some((re) => re.test(s)) || PASSWORD_P.test(s)) return true;
  for (const m of s.matchAll(HEX_RUN)) if (/[a-fA-F]/.test(m[0]) && /[0-9]/.test(m[0])) return true;
  for (const m of s.matchAll(B64_RUN)) if (randomLooking(m[0])) return true;
  return false;
}

/** The hash a saved rule matches on: a rule's key never sits on disk. */
export function ruleKeyHash(ruleKey: string): string {
  return createHash("sha256").update(`clover-saved-rule-v1\u0000${ruleKey}`).digest("hex");
}

/** The longest display string a saved rule keeps. */
export const RULE_DISPLAY_MAX = 200;

/** What a saved rule shows in a list: the key with hiding characters escaped, anything credential-shaped in it
 *  replaced (a key with one is never saved; this is the second guard), and clipped. */
export function ruleDisplay(ruleKey: string): string {
  let shown = shownCode(ruleKey).replace(/[\n\t]/g, " ");
  shown = shown.replace(HEX_RUN, "…").replace(B64_RUN, (m) => (randomLooking(m) ? "…" : m));
  shown = shown.replace(/((?:token|key|secret|passw(?:or)?d|pwd|credential|auth|sig|signature)s?=)[^\s&;"')]+/gi, "$1…");
  return shown.length > RULE_DISPLAY_MAX ? `${shown.slice(0, RULE_DISPLAY_MAX - 1)}…` : shown;
}
