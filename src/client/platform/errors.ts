export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
}
export function errorName(error: unknown): string {
	return error instanceof Error ? error.name : '';
}
