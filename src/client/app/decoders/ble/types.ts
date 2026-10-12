export interface MacVendorDatabase {
	bytes: Uint8Array;
	count: number;
}

export interface MacVendorManifest {
	schema: 1;
	revision: string;
	bytes: number;
	count: number;
	sha256: string;
}
