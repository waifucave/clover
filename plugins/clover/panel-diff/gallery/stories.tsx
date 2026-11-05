// Every diff panel state the gallery shows.
import { DiffLayoutSwitch, DiffPanel, DiffTitle } from "../client/DiffPanel";
import { FILES } from "./fixtures";
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
    id: "panel-diff/empty",
    title: "No changes",
    width: 480,
    render: () => <DiffPanel files={[]} layout="unified" />,
  },
];
