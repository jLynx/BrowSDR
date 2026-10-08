import { describe, expect, it } from 'vitest';
import { computedProperties } from '@/app/core/computed';

const active = (state) => computedProperties.activeAudioVfos.call({ running: true, ...state }).map((item) => item.index);

describe('active audio indicators', () => {
	it('shows only playing DSD VFOs even with RF squelch disabled', () => {
		const vfos = Array.from({ length: 9 }, () => ({ mode: 'dsd', enabled: true, squelchEnabled: false }));
		expect(active({ vfos, vfoSquelchOpen: [] })).toEqual([]);
		expect(active({ vfos, vfoSquelchOpen: [false, false, false, false, false, false, false, false, true] })).toEqual([8]);
		expect(active({ vfos, vfoSquelchOpen: Array(9).fill(false) })).toEqual([]);
	});
	it('preserves analog squelch behavior and excludes muted or stopped playback', () => {
		const state = {
			vfos: [
				{ mode: 'nfm', enabled: true, squelchEnabled: false },
				{ mode: 'nfm', enabled: true, squelchEnabled: true },
				{ mode: 'dsd', enabled: false, squelchEnabled: false },
			],
			vfoSquelchOpen: [false, false, true],
		};
		expect(active(state)).toEqual([0]);
		state.vfoSquelchOpen[1] = true;
		expect(active(state)).toEqual([0, 1]);
		expect(active({ ...state, running: false })).toEqual([]);
	});
});
