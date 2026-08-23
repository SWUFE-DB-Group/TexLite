export type ClientToolStatus = "loading" | "working" | "error";

export interface ClientToolRuntimeState {
  status: ClientToolStatus;
  error: string;
}

type Listener = () => void;

/** Small external store shared by optional writing tools and the settings UI. */
export function createClientToolStatusStore() {
  let state: ClientToolRuntimeState = { status: "loading", error: "" };
  const listeners = new Set<Listener>();

  const update = (status: ClientToolStatus, error = "") => {
    if (state.status === status && state.error === error) return;
    state = { status, error };
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loading: () => update("loading"),
    working: () => update("working"),
    failed: (error: unknown) => update("error", error instanceof Error ? error.message : String(error))
  };
}

export const texFmtToolStatus = createClientToolStatusStore();
