// Every string the terminal panel shows, for the move to `clover.` keys (plan, F-M3).
export const S = {
  terminals: "Terminals",
  newTerminal: "New terminal",
  close: (title: string) => `Close ${title}`,
  output: (title: string) => `${title} output`,
  exited: (code: number) => `Exited with code ${code}`,
};
