// Mission Control i18n core. Loaded as a classic script by the browser and imported for its side effect by the server.
// English is the source language: every key in a catalog is the English text, with {name} placeholders.
// Catalogs live in public/locales/*.js and register themselves in globalThis.MC_I18N_CATALOGS.<lang>.
(function () {
  const languages = Object.freeze(['en', 'pt']);
  const tags = Object.freeze({ en: 'en-US', pt: 'pt-BR' });
  const compiled = new Map();
  const normalize = lang => {
    const value = String(lang || '').trim().toLowerCase();
    if (languages.includes(value)) return value;
    const base = value.split(/[-_]/)[0];
    return languages.includes(base) ? base : 'en';
  };
  const catalog = lang => (globalThis.MC_I18N_CATALOGS && globalThis.MC_I18N_CATALOGS[lang]) || {};
  const format = (template, params) => params && typeof params === 'object'
    ? String(template).replace(/\{(\w+)\}/g, (whole, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
    : String(template);
  // t: translate a known English key (optionally with {placeholders}) and fill in the parameters.
  const t = (lang, key, params) => {
    const lng = normalize(lang);
    const entries = lng === 'en' ? null : catalog(lng);
    const template = entries && Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : key;
    return format(template, params);
  };
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = lng => {
    const entries = catalog(lng);
    const cached = compiled.get(lng);
    const size = Object.keys(entries).length;
    if (cached && cached.size === size) return cached.list;
    const list = [];
    for (const [key, value] of Object.entries(entries)) {
      if (!/\{\w+\}/.test(key)) continue;
      const names = [];
      const source = escape(key).replace(/\\\{(\w+)\\\}/g, (whole, name) => { names.push(name); return '([\\s\\S]+?)'; });
      list.push({ regex: new RegExp('^' + source + '$'), names, value });
    }
    // Longer templates first, so the most specific message wins.
    list.sort((a, b) => b.regex.source.length - a.regex.source.length);
    compiled.set(lng, { size, list });
    return list;
  };
  // translate: translate text that was already produced in English (for example a server message).
  // Exact keys win; otherwise templates with placeholders are matched. Unknown text is returned unchanged.
  const translate = (lang, text) => {
    const lng = normalize(lang);
    if (lng === 'en' || typeof text !== 'string' || !text) return text;
    const entries = catalog(lng);
    if (Object.prototype.hasOwnProperty.call(entries, text)) return entries[text];
    for (const pattern of patterns(lng)) {
      const found = pattern.regex.exec(text);
      if (!found) continue;
      const params = {};
      pattern.names.forEach((name, i) => { params[name] = found[i + 1]; });
      return format(pattern.value, params);
    }
    return text;
  };
  globalThis.MC_I18N = Object.freeze({ languages, tags, normalize, format, t, translate, locale: lang => tags[normalize(lang)] });
})();
