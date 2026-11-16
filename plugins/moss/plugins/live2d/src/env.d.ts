// Stylesheets are imported as text (`with { type: "text" }`) and injected once per document.
declare module "*.css" {
  const text: string;
  export default text;
}
