// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AvatarStylePicker } from "../src/client/AvatarStylePicker";
import { Modal } from "../src/client/Dialog";
import i18n from "../src/client/i18n";

describe("avatar picker inside the real settings dialog", () => {
  it("keeps search focus inside the dialog, selects by keyboard and dismisses via the trigger or outside click", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const closeDialog = vi.fn();
    function Settings() {
      const [value, setValue] = useState<string | null>("lorelei");
      return createElement(Modal, { open: true, title: "Avatar", description: "Choose a style", onOpenChange: closeDialog,
        children: createElement(AvatarStylePicker, { value, disabled: false, onChange: setValue }) });
    }
    try {
      await i18n.changeLanguage("en");
      await act(async () => root.render(createElement(Settings)));
      const trigger = document.querySelector<HTMLButtonElement>(".avatar-style-trigger")!;
      await act(async () => trigger.click());
      const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
      expect(document.activeElement).toBe(input);
      expect(input.closest('[role="dialog"]')?.classList.contains("dialog-content")).toBe(false);
      expect(document.querySelector('.dialog-content .avatar-style-popover')).not.toBeNull();
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe("Lorelei");
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(trigger.textContent).toBe("Lorelei Neutral");
      expect(document.activeElement).toBe(trigger);
      await act(async () => trigger.click());
      await act(async () => trigger.click());
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(document.querySelector('.dialog-content')).not.toBeNull();
      expect(closeDialog).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
      await act(async () => trigger.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const outside = document.querySelector('.dialog-header')!;
      await act(async () => {
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
        outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
        outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(closeDialog).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
