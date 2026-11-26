import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { ThemeProvider, useTheme, ThemeToggle } from "../lib/theme.js";

describe("Cross-Web Day/Night Theme System", () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    const fakeLocalStorage = {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, val: string) => {
        mockStorage[key] = val;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    };

    vi.stubGlobal("localStorage", fakeLocalStorage);

    // Mock document.documentElement
    const rootAttrs: Record<string, string> = {};
    const rootClasses = new Set<string>();

    const fakeDocElement = {
      setAttribute: vi.fn((k: string, v: string) => {
        rootAttrs[k] = v;
      }),
      getAttribute: vi.fn((k: string) => rootAttrs[k] ?? null),
      classList: {
        add: vi.fn((cls: string) => rootClasses.add(cls)),
        remove: vi.fn((cls: string) => rootClasses.delete(cls)),
        contains: vi.fn((cls: string) => rootClasses.has(cls)),
      },
    };

    vi.stubGlobal("document", {
      documentElement: fakeDocElement,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults initial theme to 'day' (taking current app styling as day)", () => {
    function Consumer() {
      const { theme } = useTheme();
      return React.createElement("div", { "data-testid": "theme" }, theme);
    }

    const html = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(Consumer, null)
      )
    );

    expect(html).toContain("day");
  });

  it("renders ThemeToggle with Day icon and label when in day mode", () => {
    const html = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ThemeToggle, null)
      )
    );

    expect(html).toContain("☀️");
    expect(html).toContain("Day");
    expect(html).toContain("Day (Pale light mode)");
    expect(html).toContain("Night");
    expect(html).toContain("bg-slate-100");
    expect(html).toContain("text-slate-800");
  });

  it("renders ThemeToggle cleanly when showLabel is false", () => {
    const html = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ThemeToggle, { showLabel: false })
      )
    );

    expect(html).toContain("☀️");
    expect(html).not.toContain("Day</span>");
  });

  it("initializes with night mode when stored in localStorage", () => {
    mockStorage["ahos_theme"] = "night";

    function Consumer() {
      const { theme } = useTheme();
      return React.createElement("div", { "data-testid": "theme" }, theme);
    }

    const html = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(Consumer, null)
      )
    );

    expect(html).toContain("night");
  });

  it("renders ThemeToggle with Moon icon and dark button classes when in night mode", () => {
    mockStorage["ahos_theme"] = "night";

    const html = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ThemeToggle, null)
      )
    );

    expect(html).toContain("🌙");
    expect(html).toContain("Night");
    expect(html).toContain("Night (Dark mode)");
    expect(html).toContain("bg-slate-800");
    expect(html).toContain("text-indigo-300");
  });

  it("provides safe fallback when useTheme is called outside ThemeProvider", () => {
    function StandaloneConsumer() {
      const { theme } = useTheme();
      return React.createElement("span", null, theme);
    }

    const html = renderToString(React.createElement(StandaloneConsumer, null));
    expect(html).toContain("day");
  });
});
