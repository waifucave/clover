// The terminal's line icons: Lucide's (ISC, `LICENSES/lucide-react.txt`), 16 px at Lucide's 2 stroke (a
// 1.3 px line, as the reference app's). Decorative: the button beside each carries the label.
import { Plus, X } from "lucide-react";

export const IconPlus = () => <Plus className="cl-term-icon" size={18} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
export const IconClose = () => <X className="cl-term-icon" size={14} strokeWidth={2} aria-hidden="true" focusable="false" />;
