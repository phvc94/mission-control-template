// Server side of the i18n layer: same core and catalogs the browser uses.
import '../public/i18n.js';
import '../public/locales/pt.js';
import '../public/locales/pt-messages.js';
export const i18n = globalThis.MC_I18N;
// Language requested by the interface (header x-mc-lang); defaults to English.
export const requestLanguage = req => i18n.normalize(req?.headers?.['x-mc-lang']);
export const translate = (lang, text) => i18n.translate(lang, text);
export const t = (lang, key, params) => i18n.t(lang, key, params);
