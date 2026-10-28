import type { ButtonHTMLAttributes } from "react";
import { CheckCircle2, LoaderCircle, Save } from "lucide-react";

/** Shared presentation; the owning workflow decides when a save has succeeded. */
export function SaveButton({ children, className = "", saving = false, feedback = "", iconSize = 14, disabled, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  saving?: boolean;
  feedback?: string;
  iconSize?: number;
}) {
  const confirmed = !saving && Boolean(feedback);
  return <button {...props} type={type} className={`save-button ${className}`.trim()} disabled={disabled || saving}
    aria-busy={saving} data-save-feedback={confirmed ? "true" : undefined}>
    {saving ? <LoaderCircle className="spin" size={iconSize} aria-hidden />
      : confirmed ? <CheckCircle2 className="save-button-confirmation" size={iconSize} aria-hidden />
        : <Save size={iconSize} aria-hidden />}
    <span role="status" aria-live="polite">{confirmed ? feedback : children}</span>
  </button>;
}
