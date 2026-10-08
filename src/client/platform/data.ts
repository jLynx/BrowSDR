export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copy persisted primitive fields only when they match the current contract. */
export function restoreFields<T extends object>(target: T, value: unknown): void {
	if (!isRecord(value)) return;
	for (const key of Object.keys(target) as Array<keyof T>) {
		const field = value[String(key)];
		if (typeof field === typeof target[key] && (typeof field !== 'number' || Number.isFinite(field))) {
			target[key] = field as T[keyof T];
		}
	}
}

export function primitiveMap<T extends string | number | boolean>(
	value: unknown,
	kind: 'string' | 'number' | 'boolean',
): value is Record<string, T> {
	return isRecord(value) && Object.values(value).every((field) => typeof field === kind && (kind !== 'number' || Number.isFinite(field)));
}
