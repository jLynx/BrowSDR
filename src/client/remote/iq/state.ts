export function createRemoteIqState() {
	return {
		remoteDecoding: 'client' as 'client' | 'host',
		remoteIqSupported: false,
		remoteIqActive: false,
		remoteIqKeys: [] as string[],
		remoteIqRevisions: [] as number[],
		remoteIqRevision: 0,
	};
}
