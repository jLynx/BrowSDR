export interface SnapshotFile {
	path: string;
	bytes: number;
	count: number;
	sha256: string;
}

export interface SnapshotManifest {
	schema: number;
	revision: string;
	builtAt: string;
	files: Record<string, SnapshotFile>;
}

export type OfflineSnapshotState = 'missing' | 'current' | 'update';
export interface DatabaseFormat {
	keySize: number;
	fieldSizes: number[];
}
