import { describe, expect, it, vi } from 'vitest';
import { mountCanvas } from '@/app/display/canvas';
import type { AppInstance } from '@/app/core/receiver.types';

describe('canvas mouse panning', () => {
	it.each(['fft', 'waterfall'] as const)('pans %s with the middle or right button without tuning', (surface) => {
		const refs = {
			fft: document.createElement('canvas'),
			waterfall: document.createElement('canvas'),
			hoverTick: document.createElement('div'),
		};
		const canvas = refs[surface];
		vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000 } as DOMRect);
		const app = {
			$refs: refs,
			workspace: {},
			view: { zoomScale: 2, zoomOffset: 0.25, locked: false },
			minFreq: 100,
			maxFreq: 110,
			activeVfoIndex: 0,
			vfos: [{ freq: 105 }],
			updateBackendVfoParams: vi.fn(),
			validateAndApplyVfoFreq: vi.fn(),
			applyZoomToEngine: vi.fn(),
			_canvasCleanup: () => {},
		};
		mountCanvas.call(app as unknown as AppInstance);
		try {
			for (const button of [1, 2]) {
				app.view.zoomOffset = 0.25;
				const down = new MouseEvent('mousedown', { button, clientX: 500, cancelable: true });
				canvas.dispatchEvent(down);
				expect(down.defaultPrevented).toBe(true);
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }));
				expect(app.view.zoomOffset).toBeCloseTo(0.2);
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: -1000 }));
				expect(app.view.zoomOffset).toBe(0.5);
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000 }));
				expect(app.view.zoomOffset).toBe(0);
				canvas.dispatchEvent(new MouseEvent('mouseup', { button }));
				canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
				expect(app.view.zoomOffset).toBe(0);
			}
			expect(app.vfos[0].freq).toBe(105);
			expect(app.updateBackendVfoParams).not.toHaveBeenCalled();
			expect(app.validateAndApplyVfoFreq).not.toHaveBeenCalled();
			expect(app.applyZoomToEngine).toHaveBeenCalledTimes(7);
		} finally {
			app._canvasCleanup();
		}
	});
});
