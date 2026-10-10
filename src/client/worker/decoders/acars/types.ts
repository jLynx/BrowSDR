import type { AcarsRecord } from '@jlynx_/acars-decoder';
export type { AcarsRecord, AcarsReport } from '@jlynx_/acars-decoder';

export interface AcarsStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	frames: number;
}

export interface AcarsMessage {
	type: 'acars';
	freq: number;
	status: AcarsStatus;
	messages: AcarsRecord[];
}
