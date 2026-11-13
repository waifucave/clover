// What a Browser acting card says, in words (the owner's ask on 14f): the act ("Click the button "Say hello"", "Type
// "hi" into the field "Email"", "Press Enter") from the element the tool already listed in its last `read` for the
// session (`e12 button "Say hello" at …`, parsed off that result as the tool returned it), never a bare ref. The names
// are the page's own words, so each is cut to a line, quoted, and never carries a control character. A secure field's
// text is never shown (the tool's floor refuses it anyway), and neither is text typed where the element is unknown.

export interface ReadElement { role: string; name: string; secure: boolean }

const MAX_SESSIONS = 64;
const MAX_ELEMENTS = 500;
const NAME_COLUMNS = 60;
const TEXT_COLUMNS = 60;

/** One element line of the tool's `read`: ref, role, then the quoted name, then the rest (value, flags, box). */
const ELEMENT_LINE = /^(e\d{1,9}) ([a-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?(?: |$)(.*)$/;

export function parseReadElements(text: string): Map<string, ReadElement> {
  const out = new Map<string, ReadElement>();
  for (const raw of text.split("\n")) {
    const m = ELEMENT_LINE.exec(raw.trim());
    if (m === null) continue;
    const rest = m[4] ?? "";
    out.set(m[1]!, { role: m[2]!, name: m[3] ?? "", secure: rest.includes("password or payment field") });
    if (out.size >= MAX_ELEMENTS) break;
  }
  return out;
}

/** The elements each session's last `read` listed, by ref; a new read replaces the session's list. */
export class ReadElements {
  readonly #bySession = new Map<string, Map<string, ReadElement>>();

  /** A tool result (any shape): when it lists elements, they replace the session's. */
  note(sessionId: string, response: unknown): void {
    const texts: string[] = [];
    const walk = (v: unknown, depth: number): void => {
      if (typeof v === "string") texts.push(v);
      else if (depth < 4 && Array.isArray(v)) for (const x of v) walk(x, depth + 1);
      else if (depth < 4 && v !== null && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    };
    walk(response, 0);
    const found = new Map<string, ReadElement>();
    for (const t of texts) for (const [k, v] of parseReadElements(t)) found.set(k, v);
    if (found.size === 0) return;
    this.#bySession.delete(sessionId);
    this.#bySession.set(sessionId, found);
    while (this.#bySession.size > MAX_SESSIONS) this.#bySession.delete(this.#bySession.keys().next().value as string);
  }

  get(sessionId: string, ref: string): ReadElement | undefined {
    return this.#bySession.get(sessionId)?.get(ref);
  }
}

/** One line of the page's words: whitespace and control characters folded, cut with an ellipsis. */
export function oneLine(text: string, columns: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > columns ? `${flat.slice(0, columns - 1)}…` : flat;
}

const quoted = (t: string): string => `"${oneLine(t, NAME_COLUMNS).replace(/"/g, "'")}"`;
const thing = (e: ReadElement): string => {
  const role = e.role === "textbox" || e.role === "searchbox" || e.role === "combobox" ? "field" : e.role;
  return e.name === "" ? `the ${role}` : `the ${role} ${quoted(e.name)}`;
};

/** The act as a sentence for the person approving; `element` is what the session's last read said the ref was. */
export function browserActionWords(input: Record<string, unknown>, element: ReadElement | undefined): string {
  const verb = typeof input.verb === "string" ? input.verb : "";
  const ref = typeof input.ref === "string" && input.ref !== "";
  switch (verb) {
    case "click": {
      const double = input.double === true ? "Double-click" : "Click";
      if (ref) return element === undefined ? `${double} an element the page showed` : `${double} ${thing(element)}`;
      return `${double} a point on the page`;
    }
    case "type": {
      const text = typeof input.text === "string" ? input.text : "";
      const into = ref ? (element === undefined ? "an element the page showed" : thing(element)) : "the field that has the focus";
      const known = ref && element !== undefined && !element.secure;
      if (!known || text === "") return `Type into ${into}`;
      const shown = oneLine(text, TEXT_COLUMNS);
      return `Type "${shown.replace(/"/g, "'")}"${text.length > shown.length ? ` (${text.length} characters)` : ""} into ${into}`;
    }
    case "key": {
      const key = typeof input.key === "string" ? oneLine(input.key, 40) : "a key";
      const n = typeof input.repeat === "number" && input.repeat > 1 ? ` ${Math.floor(input.repeat)} times` : "";
      return `Press ${key}${n}`;
    }
    case "select": {
      const option = typeof input.option === "string" ? oneLine(input.option, 40) : "";
      const into = ref && element !== undefined ? thing(element) : "a drop-down on the page";
      return option === "" ? `Choose an option in ${into}` : `Choose "${option.replace(/"/g, "'")}" in ${into}`;
    }
    default:
      return "Use the page";
  }
}
