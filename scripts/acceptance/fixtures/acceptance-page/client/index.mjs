// The acceptance page plugin's one piece of UI: a line in the shell's status bar, drawn by its own layer. Installing it
// makes the window's document load again (the layers a document may frame are fixed when it is served), and the run
// checks the Plugins page is still where the user was.
export function PageStatus() {
  return "Acceptance page plugin";
}
