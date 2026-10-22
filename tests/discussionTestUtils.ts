import { createElement, type ReactNode } from "react";
import { QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { createDiscussionQueryClient } from "../src/client/workspace/discussionCache";

// Keep observer notifications inside React's async act() rather than a timer.
notifyManager.setScheduler(queueMicrotask);
export function discussionTestClient() {
  const client = createDiscussionQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
}
export function withDiscussionQueries(children: ReactNode, client = discussionTestClient()) {
  return createElement(QueryClientProvider, { client }, children);
}
