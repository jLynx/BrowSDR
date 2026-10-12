export interface DatabaseFile {
	path: string;
	bytes: number;
	count: number;
	sha256: string;
}

export interface SourceDigest {
	url: string;
	sha256: string;
}

export interface DatabaseManifest {
	schema: 1;
	revision: string;
	builtAt: string;
	sources: SourceDigest[];
	files: Record<string, DatabaseFile>;
}
