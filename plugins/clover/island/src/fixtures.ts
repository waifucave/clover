// Mock data for the tests and the gallery: cards and the words their sealed parts would show. Made up.

import type { ApprovalCard, LinkCard, QuestionCard } from "./model/cards";
import type { ScreenShape } from "./model/geometry";
import type { SealedFixtures } from "./mock-kit";

export const NOTCH: ScreenShape = { housing: { width: 185, height: 32 }, menuBarHeight: 32 };
export const NO_NOTCH: ScreenShape = { housing: null, menuBarHeight: 24 };

export const ALPHA = { id: "alpha", name: "Alpha" };

export const APPROVAL: ApprovalCard = { id: "approval-1", kind: "approval", source: ALPHA, computer: "Studio", issuedAt: 0 };
export const APPROVAL_2: ApprovalCard = { id: "approval-2", kind: "approval", source: { id: "luna", name: "Luna" }, issuedAt: 1 };
export const LINK: LinkCard = { id: "link-1", kind: "link", source: ALPHA, issuedAt: 2 };

export const QUESTION: QuestionCard = {
  id: "question-1",
  kind: "question",
  source: ALPHA,
  issuedAt: 3,
  questions: [
    {
      question: "Which branch should I open the pull request against?",
      header: "Branch",
      multiSelect: false,
      options: [{ label: "main" }, { label: "release/1.111" }, { label: "Leave it as a draft" }],
    },
  ],
};

export const QUESTIONS_2: QuestionCard = {
  id: "question-2",
  kind: "question",
  source: ALPHA,
  issuedAt: 4,
  questions: [
    { question: "Which files should the summary cover?", multiSelect: true, options: [{ label: "README.md" }, { label: "CHANGELOG.md" }, { label: "docs/guide.md" }] },
    { question: "Anything I should leave out?", multiSelect: false, options: [] },
  ],
};

export const SEALED: SealedFixtures = {
  "approval-1": {
    source: "Alpha · Bash",
    ask: "Run a command that deletes the build folder and rebuilds the site",
    command: "rm -rf dist && bun run build",
    computer: "Studio",
    risk: "Changes files",
  },
  "approval-2": { source: "Luna · Write", ask: "Write notes/tarot.md", command: "notes/tarot.md (2.1 KB)" },
  "link-1": { source: "Alpha · Linear", ask: "Linear asks you to sign in to finish connecting", host: "linear.app" },
};
