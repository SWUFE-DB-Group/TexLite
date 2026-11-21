// Vite reports failed dynamic imports and CSS preloads before rejecting their
// promises. Remember the error without swallowing it or reloading the page.
const moduleLoadFailures = new WeakSet<object>();

export function recordModuleLoadFailure(event: Event): void {
  const error = (event as Event & { payload?: unknown }).payload;
  if (typeof error === "object" && error !== null) moduleLoadFailures.add(error);
}

export function isModuleLoadFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && moduleLoadFailures.has(error);
}
