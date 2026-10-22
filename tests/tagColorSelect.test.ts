// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../src/client/Dialog";
import { TagColorSelect } from "../src/client/TagColorSelect";
import i18n from "../src/client/i18n";
import type { TagColor } from "../src/client/types";

describe("tag color selection", () => {
  it("shows color swatches, selects by keyboard and preserves the owning dialog", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const closeDialog = vi.fn();
    const onChange = vi.fn();
    function Settings({ disabled = false }: { disabled?: boolean }) {
      const [value, setValue] = useState<TagColor>("blue");
      return createElement(Modal, { open: true, className: "tag-management-modal", title: "Tags", description: "Manage colors", onOpenChange: closeDialog,
        children: createElement(TagColorSelect, { value, disabled, onChange: (color) => { setValue(color); onChange(color); } }) });
    }
    const key = async (element: Element, value: string) => {
      await act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
    };
    try {
      await i18n.changeLanguage("en");
      await act(async () => root.render(createElement(Settings)));
      const trigger = document.querySelector<HTMLButtonElement>(".tag-color-select")!;
      expect(trigger.textContent).toBe("Blue");
      expect(trigger.querySelector(".tag-dot.tag-blue")).not.toBeNull();
      await key(trigger, "ArrowDown");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(options.map((option) => option.textContent)).toEqual(["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"]);
      expect(options.every((option) => option.querySelector('.tag-dot[aria-hidden="true"]'))).toBe(true);
      expect(options[4].getAttribute("aria-checked")).toBe("true");
      // Preserve the focus trap without clipping the menu to the scrollable body.
      expect(document.querySelector(".tag-color-options")?.closest(".dialog-content")).not.toBeNull();
      expect(document.querySelector(".tag-color-options")?.closest(".dialog-body")).toBeNull();
      await key(document.activeElement!, "Home");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      await key(document.activeElement!, "Enter");
      expect(onChange).toHaveBeenCalledWith("red");
      expect(trigger.textContent).toBe("Red");
      expect(trigger.querySelector(".tag-dot.tag-red")).not.toBeNull();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(closeDialog).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);

      await key(trigger, "ArrowDown");
      await act(async () => root.render(createElement(Settings, { disabled: true })));
      expect(trigger.disabled).toBe(true);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(closeDialog).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
