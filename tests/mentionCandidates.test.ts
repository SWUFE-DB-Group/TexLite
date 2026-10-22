// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";
import { MentionTextarea } from "../src/client/workspace/MentionTextarea";
import { discussionTestClient, withDiscussionQueries } from "./discussionTestUtils";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
let host: HTMLDivElement, root: Root;
let client = discussionTestClient();
const users = [{ id: "reader", username: "reader", displayName: "Researcher" }];
async function render(projectId = "project", count = 1) {
  await act(async () => root.render(withDiscussionQueries(createElement("div", null,
    ...Array.from({ length: count }, (_, index) => createElement(MentionTextarea, { key: index, projectId, value: "@", onChange: vi.fn(), autoFocus: true }))), client)));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = discussionTestClient();
  vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue({ users });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe("mention candidate queries", () => {
  it("recovers on focus after a failed request instead of caching an empty success", async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError("Temporary", 503));
    await render();
    expect(api).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="option"]')).toBeNull();
    await act(async () => { const text = host.querySelector("textarea")!; text.blur(); text.focus(); });
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="option"]')?.textContent).toContain("Researcher");
    expect(host.querySelector('[role="option"]')?.textContent).toContain("(reader)");
  });

  it("shares the candidate request between multiple open composers", async () => {
    await render("project", 2);
    expect(api).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  });

  it("does not show another project's cached users and ignores its obsolete request", async () => {
    let finish!: (result: { users: typeof users }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    vi.mocked(api).mockResolvedValue({ users: [{ id: "other", username: "other", displayName: "Other reader" }] });
    await render("other-project");
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ users }));
    expect(host.querySelector('[role="option"]')?.textContent).toContain("Other reader");
    expect(host.textContent).not.toContain("Researcher");
  });
});
