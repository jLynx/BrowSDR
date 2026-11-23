import { normalizeBasePath } from '../client/platform/base-path';

/** The assets binding stores files at its root even when the public app is mounted below it. */
export function hostedRequest(request: Request, configuredBase?: string): Request | Response {
	const base = normalizeBasePath(configuredBase);
	if (base === '/') return request;
	const url = new URL(request.url);
	if (url.pathname === base.slice(0, -1)) {
		url.pathname = base;
		return Response.redirect(url.href, 308);
	}
	if (!url.pathname.startsWith(base)) return new Response('Not found', { status: 404 });
	url.pathname = '/' + url.pathname.slice(base.length);
	return new Request(url, request);
}

export function hostedRedirect(response: Response, originalRequest: Request, configuredBase?: string): void {
	const location = response.headers.get('Location');
	if (!location) return;
	const original = new URL(originalRequest.url);
	const redirect = new URL(location, original.origin);
	if (redirect.origin !== original.origin) return;
	redirect.pathname = normalizeBasePath(configuredBase) + redirect.pathname.slice(1);
	response.headers.set('Location', redirect.href);
}
