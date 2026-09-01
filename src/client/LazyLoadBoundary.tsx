import { Suspense, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "./Dialog";
import { ErrorBoundary } from "./ErrorBoundary";

function LoadingState({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return <div className={`lazy-load-state${compact ? " compact" : ""}`} role="status" aria-live="polite">
    <LoaderCircle className="spin" size={compact ? 15 : 18} />
    <span>{t("common.loading")}</span>
  </div>;
}

function FailureState({ onClose, compact = false }: { onClose?: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  return <div className={`lazy-load-state lazy-load-error${compact ? " compact" : ""}`} role="alert">
    <span>{t("errors.boundaryDescription")}</span>
    <div className="lazy-load-actions">
      {onClose && <button type="button" onClick={onClose}>{t("common.close")}</button>}
      <button type="button" className="primary" onClick={() => window.location.reload()}>{t("common.reload")}</button>
    </div>
  </div>;
}

function ModalFailure({ title, onClose }: { title: string; onClose: () => void }) {
  return <Modal open title={title} onOpenChange={(open) => { if (!open) onClose(); }}><FailureState onClose={onClose} /></Modal>;
}

/** Keep a failed deferred page local instead of replacing the whole application. */
export function LazyPage({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return <ErrorBoundary fallback={<FailureState onClose={onClose} />}>
    <Suspense fallback={<LoadingState />}>{children}</Suspense>
  </ErrorBoundary>;
}

/** Give deferred dialogs an immediate, dismissible loading surface. */
export function LazyModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const loading = <Modal open title={title} onOpenChange={(open) => { if (!open) onClose(); }}><LoadingState /></Modal>;
  const failure = <ModalFailure title={title} onClose={onClose} />;
  return <ErrorBoundary fallback={failure}><Suspense fallback={loading}>{children}</Suspense></ErrorBoundary>;
}

/** Settings keep their narrow panel while a deferred module loads or fails. */
export function LazyPanel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <ErrorBoundary fallback={<FailureState onClose={onClose} compact />}>
    <Suspense fallback={<LoadingState compact />}>{children}</Suspense>
  </ErrorBoundary>;
}
