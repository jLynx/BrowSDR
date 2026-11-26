/** Network IQ precision is independent of the host's capture format. */
export const REMOTE_IQ_BITS = 8;

export interface IqSlicePlan {
	centerFreq: number;
	sampleRate: number;
	bandwidth: number;
	fullBand: boolean;
}

export interface SliceRequest extends IqSlicePlan {
	index: number;
	revision: number;
	bits: 8 | 16;
}

export interface IqPacket extends SliceRequest {
	sequence: number;
	scale: number;
	samples: Int8Array | Int16Array;
	discontinuity: boolean;
}
