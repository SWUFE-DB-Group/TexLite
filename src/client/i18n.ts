import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import zhHant from "./locales/zh-Hant.json";
import { documentLocale, supportedLocale, supportedLocales } from "../shared/locales";
import { agentMessages } from "../shared/agentMessages";
import { suggestionMessages } from "../shared/suggestionMessages";
import { viewLinkMessages } from "../shared/projectViewLinks";
import { citationCollectionMessages } from "../shared/citationCollections";
import { projectSearchMessages } from "../shared/projectSearch";
import { agentUiMessages } from "./agents/messages";
import { tikzGalleryMessages } from "./tikzGallery/messages";

// Register before initialization so detected/saved languages and later switches
// both update the page language used by browsers and assistive technology.
i18n.on("languageChanged", () => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = documentLocale(i18n.resolvedLanguage);
  }
});

void i18n.use(LanguageDetector).use(initReactI18next).init({
  resources: {
    en: { translation: { ...en, agents: agentUiMessages.en, gallery: tikzGalleryMessages.en, errors: { ...en.errors, codes: { ...en.errors.codes, ...projectSearchMessages.en, ...agentMessages.en, ...suggestionMessages.en, ...viewLinkMessages.en, ...citationCollectionMessages.en } } } },
    zh: { translation: { ...zh, agents: agentUiMessages.zh, gallery: tikzGalleryMessages.zh, errors: { ...zh.errors, codes: { ...zh.errors.codes, ...projectSearchMessages.zh, ...agentMessages.zh, ...suggestionMessages.zh, ...viewLinkMessages.zh, ...citationCollectionMessages.zh } } } },
    "zh-Hant": { translation: { ...zhHant, agents: agentUiMessages["zh-Hant"], gallery: tikzGalleryMessages["zh-Hant"], errors: { ...zhHant.errors, codes: { ...zhHant.errors.codes, ...projectSearchMessages["zh-Hant"], ...agentMessages["zh-Hant"], ...suggestionMessages["zh-Hant"], ...viewLinkMessages["zh-Hant"], ...citationCollectionMessages["zh-Hant"] } } } }
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
