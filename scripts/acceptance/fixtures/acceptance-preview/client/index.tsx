// The acceptance run's `file.preview` filler: it gets the spot's props (the file's path and media type) as `props` and draws the
// file's name and type, nothing else. TSX importing React only.
export function ImagePreview({ props }: { props: { path: string; mediaType: string } }) {
  const name = props.path.split("/").at(-1) ?? props.path;
  return (
    <div data-acceptance-preview="main" data-media-type={props.mediaType}>
      {name} ({props.mediaType})
    </div>
  );
}
