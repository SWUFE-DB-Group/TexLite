import type { SVGProps } from "react";

/** The familiar Markdown M and downward arrow, without a surrounding frame. */
export function MarkdownDocumentIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" {...props}>
    <path d="M2.5 17V7l5 5 5-5v10M19.5 7v10m-3-3 3 3 3-3" />
  </svg>;
}
