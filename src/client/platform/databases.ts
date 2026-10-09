const configuredBase: unknown = import.meta.env.VITE_DATABASES_URL;
/** Existing R2 domain remains valid while the physical bucket/domain migration is prepared. */
export const DATABASES_BASE = (typeof configuredBase === 'string' ? configuredBase : 'https://aircraft-db.browsdr.jlynx.net/').replace(
	/\/?$/,
	'/',
);
