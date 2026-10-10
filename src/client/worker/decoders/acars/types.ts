export interface AcarsRecord {
	id: number;
	receivedAt: number;
	registration: string;
	mode: string;
	acknowledgement: string;
	label: string;
	blockId: string;
	direction: 'downlink' | 'uplink';
	messageNumber?: string;
	flight?: string;
	text: string;
	continuation: boolean;
}

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

export type AcarsReport = Omit<AcarsRecord, 'id' | 'receivedAt'>;
