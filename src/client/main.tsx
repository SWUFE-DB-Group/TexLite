import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { GlobalTooltip } from "./GlobalTooltip";
import "./i18n";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GlobalTooltip />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
