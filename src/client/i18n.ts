import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

// Register before initialization so detected/saved languages and later switches
// both update the page language used by browsers and assistive technology.
i18n.on("languageChanged", () => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en";
  }
});

void i18n.use(LanguageDetector).use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  fallbackLng: "en",
  supportedLngs: ["en", "zh"],
  nonExplicitSupportedLngs: true,
  interpolation: { escapeValue: false },
  detection: { order: ["localStorage", "navigator"], caches: ["localStorage"] }
});

export default i18n;
