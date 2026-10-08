import { SyncType } from './types';
import type { DSDMode } from './types';
/** Invert a dibit (0 ↔ 2, 1 ↔ 3). */
export function invertDibit(d: number): number {
	return d ^ 2;
}

const syncLabels: Readonly<Partial<Record<SyncType, string>>> = {
	[SyncType.P25P1]: 'P25P1',
	[SyncType.INV_P25P1]: '-P25P1',
	[SyncType.DMR_BS_DATA]: 'DMR_BS_DATA',
	[SyncType.DMR_BS_VOICE]: 'DMR_BS_VOICE',
	[SyncType.DMR_MS_DATA]: 'DMR_MS_DATA',
	[SyncType.DMR_MS_VOICE]: 'DMR_MS_VOICE',
	[SyncType.DMR_DM_TS1_DATA]: 'DMR_DM1_DATA',
	[SyncType.DMR_DM_TS1_VOICE]: 'DMR_DM1_VOICE',
	[SyncType.DMR_DM_TS2_DATA]: 'DMR_DM2_DATA',
	[SyncType.DMR_DM_TS2_VOICE]: 'DMR_DM2_VOICE',
	[SyncType.DSTAR]: 'DSTAR',
	[SyncType.INV_DSTAR]: '-DSTAR',
	[SyncType.DSTAR_HD]: 'DSTAR_HD',
	[SyncType.INV_DSTAR_HD]: '-DSTAR_HD',
	[SyncType.NXDN_MS_DATA]: 'NXDN_MS_DATA',
	[SyncType.INV_NXDN_MS_DATA]: '-NXDN_MS_DATA',
	[SyncType.NXDN_MS_VOICE]: 'NXDN_MS_VOICE',
	[SyncType.INV_NXDN_MS_VOICE]: '-NXDN_MS_VOICE',
	[SyncType.NXDN_BS_DATA]: 'NXDN_BS_DATA',
	[SyncType.INV_NXDN_BS_DATA]: '-NXDN_BS_DATA',
	[SyncType.NXDN_BS_VOICE]: 'NXDN_BS_VOICE',
	[SyncType.INV_NXDN_BS_VOICE]: '-NXDN_BS_VOICE',
};

/** Human-readable label for a SyncType value. */
export function syncTypeLabel(st: SyncType): string {
	return syncLabels[st] ?? 'UNKNOWN';
}

const syncModes: Readonly<Partial<Record<SyncType, DSDMode>>> = {
	[SyncType.P25P1]: 'p25',
	[SyncType.INV_P25P1]: 'p25',
	[SyncType.DMR_BS_DATA]: 'dmr',
	[SyncType.DMR_BS_VOICE]: 'dmr',
	[SyncType.DMR_MS_DATA]: 'dmr',
	[SyncType.DMR_MS_VOICE]: 'dmr',
	[SyncType.DMR_DM_TS1_DATA]: 'dmr',
	[SyncType.DMR_DM_TS1_VOICE]: 'dmr',
	[SyncType.DMR_DM_TS2_DATA]: 'dmr',
	[SyncType.DMR_DM_TS2_VOICE]: 'dmr',
	[SyncType.DSTAR]: 'dstar',
	[SyncType.INV_DSTAR]: 'dstar',
	[SyncType.DSTAR_HD]: 'dstar',
	[SyncType.INV_DSTAR_HD]: 'dstar',
	[SyncType.NXDN_MS_DATA]: 'nxdn',
	[SyncType.INV_NXDN_MS_DATA]: 'nxdn',
	[SyncType.NXDN_MS_VOICE]: 'nxdn',
	[SyncType.INV_NXDN_MS_VOICE]: 'nxdn',
	[SyncType.NXDN_BS_DATA]: 'nxdn',
	[SyncType.INV_NXDN_BS_DATA]: 'nxdn',
	[SyncType.NXDN_BS_VOICE]: 'nxdn',
	[SyncType.INV_NXDN_BS_VOICE]: 'nxdn',
};

/** Map SyncType to DSDMode. */
export function syncTypeToMode(st: SyncType): DSDMode {
	return syncModes[st] ?? 'unknown';
}

/** Is this a voice sync (as opposed to data)? */
export function isVoiceSync(st: SyncType): boolean {
	switch (st) {
		case SyncType.DMR_BS_VOICE:
		case SyncType.DMR_MS_VOICE:
		case SyncType.DMR_DM_TS1_VOICE:
		case SyncType.DMR_DM_TS2_VOICE:
		case SyncType.NXDN_MS_VOICE:
		case SyncType.INV_NXDN_MS_VOICE:
		case SyncType.NXDN_BS_VOICE:
		case SyncType.INV_NXDN_BS_VOICE:
		case SyncType.P25P1:
		case SyncType.INV_P25P1:
		case SyncType.DSTAR:
		case SyncType.INV_DSTAR:
			return true;
		default:
			return false;
	}
}
