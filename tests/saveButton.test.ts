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

  it.each(["light", "dark"].flatMap((theme) => [false, true].map((agentLast) => ({ theme, agentLast }))))(
    "keeps management controls consistent in $theme mode (lazy agent CSS last=$agentLast)", async ({ theme, agentLast }) => {
      document.documentElement.dataset.theme = theme;
      addCss(agentLast ? css : agentCss); addCss(agentLast ? agentCss : css); addCss(themeCss);
      await act(async () => root.render(createElement("div", null,
        ...["admin-users-page", "citation-library-page", "agent-management"].map((page) => createElement("section", {
          className: `management-page ${page}`, key: page
        }, createElement("div", { className: "section-title" },
          createElement("button", { className: "dashboard-back-button" }, "Back to projects")),
        createElement(SaveButton, { feedback: "Saved" }, "Save"))),
        createElement("div", { className: "management-dialog" }, createElement("div", { className: "dialog-footer" },
          createElement(SaveButton, null, "Save"))),
        createElement("div", { className: "citation-library-page" }, createElement("div", { className: "citation-entry-actions" },
          createElement("button", { className: "citation-copy-button" }, createElement("span", null, "Copy BibTeX")),
          createElement("button", { className: "citation-entry-menu-trigger" }, "…"))),
        createElement("div", { className: "citation-entry-menu", role: "menu" },
          ...["Tags", "Edit", "Delete"].map((label) => createElement("div", { key: label, role: "menuitem" }, label)))
      )));
      const backs = [...host.querySelectorAll<HTMLElement>(".dashboard-back-button")].map((element) => getComputedStyle(element));
      for (const style of backs) {
        expect(style.height).toBe("32px"); expect(style.lineHeight).toBe("1");
        expect(style.fontSize).toBe("12px"); expect(style.paddingTop).toBe("0px");
      }
      expect(getComputedStyle(host.querySelector(".citation-copy-button span")!).fontSize).toBe("11px");
      for (const element of host.querySelectorAll<HTMLElement>('.citation-entry-menu [role="menuitem"]')) {
        const style = getComputedStyle(element);
        expect(style.fontSize).toBe("11px"); expect(style.minHeight).toBe("32px");
      }
      for (const element of host.querySelectorAll<HTMLElement>(".save-button")) {
        const style = getComputedStyle(element);
        expect(style.minHeight).toBe("32px"); expect(style.fontSize).toBe("12px");
        expect(style.backgroundColor).toBe(theme === "dark" ? "#282c34" : "#fff");
        expect(style.color).toBe(theme === "dark" ? "#d7dae0" : "#252b27");
      }
      expect(getComputedStyle(host.querySelector(".save-button-confirmation")!).color).toBe(theme === "dark" ? "#a9c8f5" : "#2563b4");
      for (const element of host.querySelectorAll<HTMLElement>(".citation-entry-actions button")) {
        const style = getComputedStyle(element);
        expect(style.height).toBe("32px"); expect(style.lineHeight).toBe("1");
        expect(style.fontSize).toBe(element.classList.contains("citation-copy-button") ? "11px" : "12px");
        expect(style.paddingTop).toBe("0px");
      }
    }
  );
});
