/** Deployment paths are same-origin directories, with a trailing slash. */
export function normalizeBasePath(value = '/'): string {
	if (
		!value.startsWith('/') ||
		value.startsWith('//') ||
		/[?#\\]/.test(value) ||
		value.split('/').some((part) => part === '.' || part === '..')
	) {
		throw new Error('Base path must be an absolute directory path, such as / or /sdr/.');
	}
	return value.replace(/\/+$/, '') + '/';
}
