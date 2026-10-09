export interface MidDatabase {
	schema: 1;
	revision: string;
	source: string;
	fetchedAt: string;
	mids: Record<string, string>;
}
