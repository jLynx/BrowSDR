/** Public assets and navigation stay inside the configured Vite base directory. */
export function appPath(path = ''): string {
	return import.meta.env.BASE_URL + path.replace(/^\/+/, '');
}

/** API/proxy hosting may be overridden independently of the frontend directory. */
export function backendPath(path: string): string {
	const configured: unknown = import.meta.env.VITE_BACKEND_URL;
	const base = typeof configured === 'string' && configured ? configured.replace(/\/?$/, '/') : appPath();
	return base + path.replace(/^\/+/, '');
}
