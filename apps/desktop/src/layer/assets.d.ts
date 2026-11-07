// The text imports the `clover` tree's parts use for their own stylesheets (`import css from "./x.css" with { type:
// "text" }`, which the bundler inlines).
declare module "*.css" {
  const text: string;
  export default text;
}
