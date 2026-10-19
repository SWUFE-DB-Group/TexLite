import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { setTheme, useTheme } from "./theme";

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const theme = useTheme();
  const label = t(theme === "light" ? "theme.switchToDark" : "theme.switchToLight");
  return <button type="button" className="theme-switcher" title={label} aria-label={label}
    onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
    {theme === "light" ? <Sun aria-hidden size={15} /> : <Moon aria-hidden size={15} />}
    <span>{t(theme === "light" ? "theme.light" : "theme.dark")}</span>
  </button>;
}
