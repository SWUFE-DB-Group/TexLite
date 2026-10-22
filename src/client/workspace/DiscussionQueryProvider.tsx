import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createDiscussionQueryClient } from "./discussionCache";

/** Workspace/user-scoped, in-memory only. No cache is persisted across logins. */
export function DiscussionQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createDiscussionQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
