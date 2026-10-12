export function snapshotChanged(current, next) {
	if (!/^[a-f0-9]{24}$/.test(next?.revision)) throw new Error('Invalid database revision');
	return !current || current.revision !== next.revision;
}

export async function publishedManifest(base, fetchManifest = fetch) {
	const directory = new URL(base);
	if (!directory.pathname.endsWith('/')) directory.pathname += '/';
	const response = await fetchManifest(new URL(`manifest.json?check=${Date.now()}`, directory), {
		cache: 'no-store',
		signal: AbortSignal.timeout(30000),
	});
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`Cannot verify published database: HTTP ${response.status}`);
	const value = await response.json();
	if (value.schema !== 1 || !/^[a-f0-9]{24}$/.test(value.revision)) throw new Error('Invalid published manifest');
	return value;
}
