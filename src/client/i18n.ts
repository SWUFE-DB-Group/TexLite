import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import zhHant from "./locales/zh-Hant.json";
import { documentLocale, supportedLocale, supportedLocales } from "../shared/locales";
import { agentMessages } from "../shared/agentMessages";
import { agentUiMessages } from "./agents/messages";

// Register before initialization so detected/saved languages and later switches
// both update the page language used by browsers and assistive technology.
i18n.on("languageChanged", () => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = documentLocale(i18n.resolvedLanguage);
  }
});

void i18n.use(LanguageDetector).use(initReactI18next).init({
  resources: {
    en: { translation: { ...en, agents: agentUiMessages.en, errors: { ...en.errors, codes: { ...en.errors.codes, ...agentMessages.en } } } },
    zh: { translation: { ...zh, agents: agentUiMessages.zh, errors: { ...zh.errors, codes: { ...zh.errors.codes, ...agentMessages.zh } } } },
    "zh-Hant": { translation: { ...zhHant, agents: agentUiMessages["zh-Hant"], errors: { ...zhHant.errors, codes: { ...zhHant.errors.codes, ...agentMessages["zh-Hant"] } } } }
  },
  fallbackLng: "en",
  supportedLngs: [...supportedLocales],
  load: "currentOnly",
  interpolation: { escapeValue: false },
  detection: {
    order: ["localStorage", "navigator"],
    caches: ["localStorage"],
    // Leave unsupported candidates intact so detection can try the browser's
    // next preferred language before falling back to English.
    convertDetectedLanguage: (language) => supportedLocale(language) ?? language
  }
});

export default i18n;
