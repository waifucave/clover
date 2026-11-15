// The child of the acceptance-points fixture: one entry in its parent's point, whose `greet` handler answers here.
export async function greet(args: { who?: string }): Promise<string> {
  return `hello ${String(args?.who ?? "nobody")} from the filler`;
}
