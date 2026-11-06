// An accessibility check over rendered parts (F-M3): what a screen reader and the keyboard need of every control.
// Each finding names the element; a test asks for none. It checks that
//  - every control has a name (its label, `aria-label`, `aria-labelledby`, its text, `title`; an image its `alt`);
//  - every control is in the tab order (no negative `tabindex` on one the user must reach), and nothing jumps the
//    order with a positive `tabindex`;
//  - a clickable look has a role: a `[data-clickable]`-free check is impossible in the DOM, so the parts use buttons,
//    links and form controls, and the listbox options a combobox drives through `aria-activedescendant`.
const CONTROL = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"], [role="menuitem"], [role="combobox"], [role="slider"]';

const ROVING = new Set(["treeitem", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "tab", "radio", "gridcell"]);
const COMPOSITE = '[role="tree"], [role="menu"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="grid"], [role="group"]';

function nameOf(el: Element): string {
  const doc = el.ownerDocument;
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) {
    const text = labelled.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ").trim();
    if (text) return text;
  }
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const id = el.getAttribute("id");
    const label = el.closest("label") ?? (id ? doc.querySelector(`label[for="${id}"]`) : null);
    const text = label?.textContent?.trim();
    if (text) return text;
    const placeholder = el.getAttribute("placeholder")?.trim();
    if (placeholder) return placeholder;
  }
  const text = (el.textContent ?? "").trim();
  if (text) return text;
  const img = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
  if (img) return img;
  return el.getAttribute("title")?.trim() ?? "";
}

const describe = (el: Element) => `<${el.tagName.toLowerCase()}${el.className ? ` class="${String(el.className).split(" ")[0]}"` : ""}${el.getAttribute("role") ? ` role="${el.getAttribute("role")}"` : ""}>`;

export function a11yFindings(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll(CONTROL))) {
    if (el.closest("[aria-hidden='true'], [hidden], [inert]")) continue;
    if (!nameOf(el)) out.push(`${describe(el)} has no name`);
    const tab = el.getAttribute("tabindex");
    const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
    // A composite widget's items use a roving tab stop: one item is in the tab order, the arrow keys move between the
    // rest. Such an item may be out of it when its widget has one that isn't.
    const role = el.getAttribute("role") ?? "";
    const group = ROVING.has(role) ? el.closest(COMPOSITE) : null;
    // A menu takes the focus itself when it opens (its checked item, then the arrows), so its items are never tab stops.
    const roving = group !== null && (el.closest('[role="menu"]') !== null || Array.from(group.querySelectorAll(`[role="${role}"]`)).some((x) => x.getAttribute("tabindex") === "0"));
    if (tab !== null && Number(tab) < 0 && !disabled && !roving) out.push(`${describe(el)} "${nameOf(el)}" is out of the tab order`);
  }
  for (const el of Array.from(root.querySelectorAll("[tabindex]"))) if (Number(el.getAttribute("tabindex")) > 0) out.push(`${describe(el)} jumps the tab order`);
  for (const img of Array.from(root.querySelectorAll("img"))) if (!img.hasAttribute("alt")) out.push(`${describe(img)} has no alt`);
  return out;
}
