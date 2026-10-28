import type { AprsPacket } from '@/worker/decoders/aprs/types';

export type AprsSymbolCategory = 'mobile' | 'aircraft' | 'weather' | 'infrastructure' | 'facility' | 'object' | 'other';

export interface AprsSymbolInfo {
	name: string;
	category: AprsSymbolCategory;
}

export interface AprsField {
	label: string;
	value: string;
}

export interface AprsLogEntry extends AprsPacket {
	key: string;
	vfoIndex: number;
	frequency: number;
}

export type AprsView = 'stations' | 'packets';
