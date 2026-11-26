import React, { createContext, useContext, useEffect, useState } from "react";

export type Theme = "day" | "night";

export interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "ahos_theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getInitialTheme(): Theme {
  if (typeof localStorage === "undefined") {
    return "day";
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "night" ? "night" : "day";
  } catch {
    return "day";
  }
}

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children?: React.ReactNode;
  initialTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme ?? getInitialTheme);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    if (theme === "night") {
      root.classList.add("theme-night");
      root.classList.remove("theme-day");
    } else {
      root.classList.add("theme-day");
      root.classList.remove("theme-night");
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, theme);
    }
  }, [theme]);

  const toggleTheme = () => {
    setThemeState((prev) => (prev === "day" ? "night" : "day"));
  };

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return {
      theme: "day",
      toggleTheme: () => {},
      setTheme: () => {},
    };
  }
  return ctx;
}

export interface ThemeToggleProps {
  className?: string;
  showLabel?: boolean;
}

export function ThemeToggle({ className, showLabel = true }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-all border flex items-center gap-1.5 select-none ${
        theme === "day"
          ? "bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-300 shadow-sm"
          : "bg-slate-800 hover:bg-slate-700 text-indigo-300 border-slate-700 shadow-sm"
      } ${className ?? ""}`}
      title={`Theme: ${theme === "day" ? "Day (Pale light mode)" : "Night (Dark mode)"}. Click to switch to ${
        theme === "day" ? "Night" : "Day"
      }.`}
      aria-label={`Toggle theme (currently ${theme})`}
    >
      <span className="text-xs" aria-hidden="true">
        {theme === "day" ? "☀️" : "🌙"}
      </span>
      {showLabel && (
        <span className="capitalize font-mono text-[11px] tracking-tight">
          {theme}
        </span>
      )}
    </button>
  );
}
