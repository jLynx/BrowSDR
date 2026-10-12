export interface PartIdSerialNo {
	partId: [number, number];
	serialNo: [number, number, number, number];
}

export type RxCallback = (data: Uint8Array) => void;
