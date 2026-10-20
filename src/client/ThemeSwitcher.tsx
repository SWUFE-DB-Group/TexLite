import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { setTheme, useThemePreference } from "./theme";

const options = [{ value: "light", icon: Sun }, { value: "dark", icon: Moon }, { value: "system", icon: Monitor }] as const;

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const theme = useThemePreference();
  return <div className="theme-switcher" role="group" aria-label={t("theme.title")}>
    {options.map(({ value, icon: Icon }) => <button key={value} type="button" aria-pressed={theme === value}
      onClick={() => setTheme(value)}><Icon aria-hidden size={14} /><span>{t(`theme.${value}`)}</span></button>)}
  </div>;
}
