const TAG = '[radio-proxy]';

function timestamp(): string {
	return new Date().toISOString();
}

export function info(...args: unknown[]): void {
	console.log(timestamp(), TAG, ...args);
}

export function warn(...args: unknown[]): void {
	console.warn(timestamp(), TAG, 'WARN', ...args);
}

export function error(...args: unknown[]): void {
	console.error(timestamp(), TAG, 'ERROR', ...args);
}
