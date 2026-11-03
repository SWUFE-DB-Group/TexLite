// @vitest-environment happy-dom
import fs from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveButton } from "../src/client/SaveButton";

const css = fs.readFileSync("src/client/styles.css", "utf8");
const agentCss = fs.readFileSync("src/client/agents/agents.css", "utf8");
const themeCss = fs.readFileSync("src/client/siteTheme.css", "utf8");
let host: HTMLDivElement, root: Root;
let sheets: HTMLStyleElement[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); sheets = [];
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  for (const sheet of sheets) sheet.remove();
  document.documentElement.removeAttribute("data-theme"); vi.unstubAllGlobals();
});
const button = () => host.querySelector<HTMLButtonElement>("button")!;
function addCss(value: string) {
  const sheet = document.createElement("style"); sheet.textContent = value; document.head.append(sheet); sheets.push(sheet);
}

describe("shared save controls", () => {
  it("uses save, busy and confirmed states without claiming success while a request is pending", async () => {
    const click = vi.fn();
    const render = (saving = false, feedback = "", disabled = false) => act(async () => root.render(
      createElement(SaveButton, { saving, feedback, disabled, onClick: click }, "Save")
    ));
    await render();
    expect(button().type).toBe("button");
    expect(button().querySelector(".lucide-save")).not.toBeNull();
    await render(true, "Saved");
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().querySelector(".lucide-loader-circle")).not.toBeNull();
    expect(button().textContent).toBe("Save");
    expect(button().hasAttribute("data-save-feedback")).toBe(false);
    await act(async () => button().click()); expect(click).not.toHaveBeenCalled();
    await render(false, "Saved", true);
    expect(button().disabled).toBe(true); // A successfully saved, unchanged form stays disabled.
    expect(button().querySelector(".save-button-confirmation")).not.toBeNull();
    expect(button().querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(button().textContent).toBe("Saved");
    await render();
    expect(button().querySelector(".lucide-save")).not.toBeNull();
    expect(button().disabled).toBe(false);
  });

  it("supports icon-only actions without losing accessible names or busy and saved feedback", async () => {
    addCss(css);
    const render = (saving = false, feedback = "") => act(async () => root.render(createElement("div", { className: "citation-entry-actions" },
      createElement(SaveButton, { iconOnly: true, className: "citation-icon-action", "aria-label": "Update", saving, feedback,
        icon: createElement("svg", { "data-test-update-icon": true }) }, "Update"))));
    await render();
    expect(button().getAttribute("aria-label")).toBe("Update");
    expect(button().querySelector("[data-test-update-icon]")).not.toBeNull();
    expect(getComputedStyle(button().querySelector<HTMLElement>(".sr-only")!).position).toBe("absolute");
    await render(true);
    expect(button().querySelector("[data-test-update-icon]")).toBeNull();
    expect(button().querySelector(".lucide-loader-circle")).not.toBeNull();
    await render(false, "Saved");
    expect(button().querySelector(".save-button-confirmation")).not.toBeNull();
    expect(button().querySelector('[role="status"]')?.textContent).toBe("Saved");
  });

  it.each(["light", "dark"].flatMap((theme) => [false, true].map((agentLast) => ({ theme, agentLast }))))(
    "keeps shared save styles intact across contexts in $theme mode (lazy agent CSS last=$agentLast)", async ({ theme, agentLast }) => {
      document.documentElement.dataset.theme = theme;
      addCss(agentLast ? css : agentCss); addCss(agentLast ? agentCss : css); addCss(themeCss);
      await act(async () => root.render(createElement("div", null,
        createElement(SaveButton, { feedback: "Saved", id: "save-reference" }, "Save"),
        ...["admin-users-page", "citation-library-page", "agent-management"].map((page) => createElement("section", {
          className: `management-page ${page}`, key: page
        },
        createElement(SaveButton, { feedback: "Saved" }, "Save"))),
        createElement("div", { className: "management-dialog" }, createElement("div", { className: "dialog-footer" },
          createElement(SaveButton, { feedback: "Saved" }, "Save")))
      )));
      const reference = host.querySelector<HTMLElement>("#save-reference")!;
      const expectedStyle = getComputedStyle(reference);
      const expectedConfirmationColor = getComputedStyle(reference.querySelector(".save-button-confirmation")!).color;
      expect(expectedConfirmationColor).not.toBe(expectedStyle.color);
      for (const element of host.querySelectorAll<HTMLElement>(".management-page .save-button, .management-dialog .save-button")) {
        const style = getComputedStyle(element);
        for (const property of ["minHeight", "fontSize", "backgroundColor", "color"] as const) {
          expect(style[property], `${element.parentElement?.className}: ${property}`).toBe(expectedStyle[property]);
        }
        expect(getComputedStyle(element.querySelector(".save-button-confirmation")!).color).toBe(expectedConfirmationColor);
      }
    }
  );
});
