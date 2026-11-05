// Every files panel state the gallery shows.
import { FilesPanel } from "../client/FilesPanel";
import { LISTING, OPEN_FILE, ROOT } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

export const filesStories: Story[] = [
  {
    id: "panel-files/empty",
    title: "The tree, with no file open",
    notes: "A filter box over the project's tree; the viewer says how to open a file.",
    width: 760,
    height: 460,
    render: () => <FilesPanel root={ROOT} listing={LISTING} onOpen={noop} />,
  },
  {
    id: "panel-files/open",
    title: "A file open",
    notes: "Folders open as the host lists them; one still listing says so.",
    width: 760,
    height: 460,
    render: () => (
      <FilesPanel root={ROOT} listing={LISTING} initialOpen={[`${ROOT}/plugins`, `${ROOT}/plugins/clover`, `${ROOT}/plugins/clover/panel`, `${ROOT}/plugins/clover/panel/client`]} onOpen={noop} open={OPEN_FILE} />
    ),
  },
];
