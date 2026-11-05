// Every diff panel state the gallery shows.
import { DiffLayoutSwitch, DiffPanel, DiffTitle } from "../client/DiffPanel";
import { FILES, HIDDEN_FILE } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

function Framed({ layout }: { layout: "unified" | "split" }) {
  return (
    <div className="story-diff">
      <div className="story-diff__head">
        <DiffTitle base="main" target="working tree" targets={["last commit"]} onTarget={noop} />
        <DiffLayoutSwitch layout={layout} onChange={noop} />
      </div>
      <DiffPanel files={FILES} layout={layout} initialOpen={[FILES[0]!.path]} onOpenFile={noop} notice="Large files start folded. Open one to see it whole." />
    </div>
  );
}

export const diffStories: Story[] = [
  {
    id: "panel-diff/unified",
    title: "Changes, unified",
    notes: "main → working tree, one row per file with its counts; the first file open. Too large, binary, renamed and deleted files say so.",
    width: 720,
    render: () => <Framed layout="unified" />,
  },
  {
    id: "panel-diff/split",
    title: "Changes, split",
    notes: "Removals pair with the additions after them, row by row.",
    width: 900,
    render: () => <Framed layout="split" />,
  },
  {
    id: "panel-diff/hidden",
    title: "A change that hides characters",
    notes: "A zero-width space in the name, bidi controls that reorder a line, and tag characters that spell a word no one sees: each shows as a mark naming its code point, and the row warns.",
    width: 720,
    render: () => <DiffPanel files={[HIDDEN_FILE]} layout="unified" initialOpen={[HIDDEN_FILE.path]} />,
  },
  {
    id: "panel-diff/empty",
    title: "No changes",
    width: 480,
    render: () => <DiffPanel files={[]} layout="unified" />,
  },
];
