import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "./i18n";

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  title?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Uncaught error in component tree:", error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback(this.state.error ?? new Error("Unknown error"), this.handleReset);
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          role="alert"
          style={{
            padding: "2rem",
            margin: "1rem",
            borderRadius: "8px",
            backgroundColor: "var(--bg-secondary, #f8f9fa)",
            border: "1px solid var(--border-color, #e9ecef)",
            color: "var(--text-primary, #212529)",
            fontFamily: "system-ui, -apple-system, sans-serif"
          }}
        >
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem", color: "#dc3545" }}>
            {this.props.title ?? i18n.t("errors.boundaryTitle")}
          </h2>
          <p style={{ fontSize: "0.9rem", color: "var(--text-secondary, #6c757d)", marginBottom: "1rem" }}>
            {i18n.t("errors.boundaryDescription")}
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={this.handleReset}
              className="primary"
              style={{ padding: "0.4rem 0.8rem", borderRadius: "4px", cursor: "pointer" }}
            >
              {i18n.t("errors.boundaryRetry")}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ padding: "0.4rem 0.8rem", borderRadius: "4px", cursor: "pointer" }}
            >
              {i18n.t("errors.boundaryReload")}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
