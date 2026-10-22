import type { SVGProps } from "react";

/** Use a document outline in the preview tab and a standalone wordmark in the file tree. */
export function PdfDocumentIcon({ size = 16, variant = "document", ...props }: SVGProps<SVGSVGElement> & { size?: number; variant?: "document" | "wordmark" }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" {...props}>
    {variant === "wordmark" ? <path d="M2.5 17V7H5a2.5 2.5 0 0 1 0 5H2.5M9.5 7H11a5 5 0 0 1 0 10H9.5ZM21.5 7h-4v10m0-5H21" /> : <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
      <path transform="translate(2.4 3.1) scale(.8)" strokeWidth={1.5} d="M5.5 18v-5H7a1.5 1.5 0 0 1 0 3H5.5M10 13h1a2.5 2.5 0 0 1 0 5h-1ZM18.5 13h-3v5m0-2.5H18" />
    </>}
  </svg>;
}
