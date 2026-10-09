export interface Env {
	DATABASES: R2Bucket;
	EXPRESS_TURN_URL: string;
	EXPRESS_TURN_USER: string;
	EXPRESS_TURN_PASS: string;
	TURN_KEY_ID: string;
	TURN_KEY_API_TOKEN: string;
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

export interface IceServerEntry {
	urls: string[];
	username?: string;
	credential?: string;
}
