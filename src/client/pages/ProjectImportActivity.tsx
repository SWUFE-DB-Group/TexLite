/** Omit the label when a separate upload progress control already describes progress. */
export function ProjectImportActivity({ label }: { label?: string }) {
  return <div className="project-import-activity" role={label ? "progressbar" : undefined} aria-label={label} aria-hidden={label ? undefined : true}><span /></div>;
}
