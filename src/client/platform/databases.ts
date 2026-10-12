const configuredBase: unknown = import.meta.env.VITE_DATABASES_URL;
export const DATABASES_BASE = (typeof configuredBase === 'string' ? configuredBase : 'https://db.browser.jlynx.net/').replace(/\/?$/, '/');
