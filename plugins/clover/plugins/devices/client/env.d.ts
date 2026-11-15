// The island's sources this plugin imports read their stylesheets as text (`with { type: "text" }`), as the island's
// own env.d.ts declares; this program compiles them too, so it needs the same declaration.
declare module "*.css" {
  const text: string;
  export default text;
}
