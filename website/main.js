const localeButtons = [...document.querySelectorAll("[data-locale]")];
const localeCache = new Map();
const defaultLocale = "en";
const localeDirectory = new URL("./locales/", import.meta.url);

function readStoredLocale() {
  try {
    return window.localStorage.getItem("texlite-site-locale");
  } catch {
    return null;
  }
}

function storeLocale(locale) {
  try {
    window.localStorage.setItem("texlite-site-locale", locale);
  } catch {
    // Private browsing and file:// pages may not expose localStorage.
  }
}

function valueAt(messages, key) {
  return key.split(".").reduce((value, part) => value && value[part], messages);
}

async function loadLocale(locale) {
  if (!localeCache.has(locale)) {
    const response = await fetch(new URL(`${locale}.json`, localeDirectory), { cache: "no-cache" });
    if (!response.ok) throw new Error(`Unable to load locale ${locale}`);
    localeCache.set(locale, await response.json());
  }
  const messages = localeCache.get(locale);
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.title = valueAt(messages, "meta.title") ?? "TexLite";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const value = valueAt(messages, element.dataset.i18n ?? "");
    if (typeof value === "string") element.textContent = value;
  }
  renderHighlights(messages.highlights?.items ?? []);
  localeButtons.forEach((button) => button.classList.toggle("active", button.dataset.locale === locale));
  storeLocale(locale);
}

function renderHighlights(highlights) {
  const list = document.querySelector("#highlight-list");
  if (!list || !highlights.length) return;
  list.replaceChildren(...highlights.map((highlight) => {
    const item = document.createElement("li");
    item.className = "highlight-item";
    if (highlight.anchor) item.id = highlight.anchor;
    const mark = document.createElement("span");
    mark.className = "highlight-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "↗";
    const title = document.createElement("strong");
    title.textContent = highlight.title;
    const body = document.createElement("p");
    body.textContent = highlight.body;
    item.append(mark, title, body);
    return item;
  }));
}

async function selectLocale(locale) {
  if (locale !== "zh" && locale !== "en") return;
  localeButtons.forEach((button) => {
    button.toggleAttribute("aria-busy", button.dataset.locale === locale);
  });
  try {
    await loadLocale(locale);
  } catch (error) {
    console.error(error);
  } finally {
    localeButtons.forEach((button) => button.removeAttribute("aria-busy"));
  }
}

function detectLocale() {
  const stored = readStoredLocale();
  if (stored === "zh" || stored === "en") return stored;
  const isZh = (navigator.languages ?? [navigator.language]).some((lang) => /^zh\b/i.test(lang));
  return isZh ? "zh" : defaultLocale;
}

localeButtons.forEach((button) => button.addEventListener("click", () => void selectLocale(button.dataset.locale)));
void selectLocale(detectLocale());
