import type { SVGProps } from "react";

/** A prominent TeX wordmark with the traditional lowered E. */
export function TexDocumentIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" {...props}>
    <path d="M2 6.5h6m-3 0v10M14 9.5H9.5v10H14m-4.5-5h4M16 6.5l6 10m0-10-6 10" />
  </svg>;
}
