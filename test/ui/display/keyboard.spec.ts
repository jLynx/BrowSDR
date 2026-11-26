import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { mountCanvas } from '@/app/display/canvas';
import { zoomMethods } from '@/app/display/zoom';
import { createAppData } from '@/app/core/state';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';
import { frequencyView } from '@/display/frequency-view';
import { bookmarkMethods } from '@/app/workspace/bookmarks';
import { vfoMethods } from '@/app/radio/vfo';
import type { Bookmark } from '@/app/workspace/types';
import { ReceiverView } from '../helpers/receiver-view';

const cleanups: Array<() => void> = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.restoreAllMocks();
});

function receiver(receiverId = 'test-receiver', workspace = { selectedId: receiverId }) {
	const root = document.createElement('div');
	const refs = {
		fft: document.createElement('canvas'),
		waterfall: document.createElement('canvas'),
		hoverTick: document.createElement('div'),
	};
	for (const canvas of [refs.fft, refs.waterfall]) {
		canvas.tabIndex = 0;
		root.append(canvas);
		vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000 } as DOMRect);
	}
	document.body.append(root);
	const app = {
		...createAppData(),
		...zoomMethods,
		...bookmarkMethods,
		...vfoMethods,
		$el: root,
		$refs: refs,
		receiverId,
		workspace,
		view: { zoomScale: 4, zoomOffset: 0.375, locked: false, autoLockDisabled: false },
		get minFreq() {
			return frequencyView(this.radio, this.view).minFreq;
		},
		get maxFreq() {
			return frequencyView(this.radio, this.view).maxFreq;
		},
		_waterfallEngine: { setZoom: vi.fn() },
		_canvasCleanup: () => {},
		formatFreq: (freq: number) => freq.toFixed(6),
		showMsg: vi.fn(),
		updateBackendVfoParams: vi.fn(),
	};
	mountCanvas.call(app as unknown as AppInstance);
	cleanups.push(() => {
		app._canvasCleanup();
		root.remove();
	});
	refs.fft.focus();
	return app;
}

async function key(canvas: EventTarget, value: string, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
	canvas.dispatchEvent(event);
	await Promise.resolve();
	return event;
}

function bookmark(freq: number, name = String(freq), category = ''): Bookmark {
	return { ...makeDefaultVfo(freq), type: 'individual', name, category };
}

describe('spectrum keyboard navigation', () => {
	it('shows shortcuts beside About in a dialog with focus restoration and no waterfall hint', async () => {
		const wrapper = mount(ReceiverView, { attachTo: document.body, global: { stubs: { teleport: true } } });
		try {
			expect(wrapper.find('.spectrum-keyboard-hint').exists()).toBe(false);
			const button = wrapper.get('.sidebar-footer button[aria-label="Keyboard shortcuts"]');
			await button.trigger('click');
			const dialog = wrapper.get('[role="dialog"][aria-label="Keyboard shortcuts"]');
			expect(dialog.text()).toContain('Tune the selected VFO');
			expect(dialog.text()).toContain('Next frequency bookmark');
			expect(dialog.findAll('kbd').map((key) => key.text())).not.toContain('/');
			await dialog.trigger('keydown', { key: 'Tab' });
			expect(document.activeElement).toBe(dialog.get('button').element);
			await dialog.trigger('keydown', { key: 'Escape' });
			expect(wrapper.find('[aria-label="Keyboard shortcuts"][role="dialog"]').exists()).toBe(false);
			expect(document.activeElement).toBe(button.element);
			for (const label of ['Spectrum navigation', 'Waterfall navigation']) {
				const canvas = wrapper.get(`canvas[aria-label="${label}"]`);
				expect(canvas.attributes('tabindex')).toBe('0');
				expect(canvas.attributes('aria-keyshortcuts')).toContain('[ ]');
			}
		} finally {
			wrapper.unmount();
		}
	});
	it('tunes the selected VFO without a canvas click at full zoom, using its channel step', async () => {
		const app = receiver();
		app.view.zoomScale = 1;
		app.view.zoomOffset = 0;
		app.$refs.fft.blur();
		expect(document.activeElement).not.toBe(app.$refs.fft);
		const other = makeDefaultVfo(99);
		app.vfos.push(other);
		const previous = { ...other };
		const radio = { ...app.radio };
		expect((await key(document, 'ArrowRight')).defaultPrevented).toBe(true);
		expect(app.vfos[0].freq).toBe(100.1);
		await key(document, 'ArrowRight', { repeat: true });
		expect(app.vfos[0].freq).toBe(100.2);
		await key(document, 'ArrowLeft');
		expect(app.vfos[0].freq).toBe(100.1);
		expect(app.vfos[1]).toEqual(previous);
		expect(app.view).toMatchObject({ zoomScale: 1, zoomOffset: 0 });
		app.activeVfoIndex = 1;
		other.snapInterval = 2500;
		await key(document, 'ArrowRight');
		expect(app.vfos[1].freq).toBe(99.0025);
		expect(app.radio).toEqual(radio);
		expect(app.updateBackendVfoParams).toHaveBeenLastCalledWith(1);
	});
	it('keeps the centre anchored during zoom and observes both zoom limits', async () => {
		const app = receiver();
		const canvas = app.$refs.fft;
		await key(canvas, 'ArrowUp');
		expect(app.view.zoomScale).toBeCloseTo(4.4);
		expect((app.minFreq + app.maxFreq) / 2).toBe(100);
		await key(canvas, 'ArrowDown');
		expect(app.view.zoomScale).toBeCloseTo(3.96);
		expect((app.minFreq + app.maxFreq) / 2).toBeCloseTo(100);
		for (let i = 0; i < 70; i++) await key(canvas, 'ArrowUp');
		expect(app.view.zoomScale).toBe(100);
		for (let i = 0; i < 70; i++) await key(canvas, 'ArrowDown');
		expect(app.view.zoomScale).toBe(1);
		expect(app.view.zoomOffset).toBe(0);
	});
	it.each([4, 100])('keeps every tuning step centred at %sx zoom, including steps inside the view', async (zoomScale) => {
		const app = receiver();
		app.view.zoomScale = zoomScale;
		app.view.zoomOffset = 0.5 - 0.5 / zoomScale;
		const other = makeDefaultVfo(99);
		app.vfos.push(other);
		const otherSettings = { ...other };
		for (const direction of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) {
			await key(document, direction);
			expect((app.minFreq + app.maxFreq) / 2).toBeCloseTo(app.vfos[0].freq, 8);
			expect(app.view.zoomScale).toBe(zoomScale);
		}
		expect(app.vfos[1]).toEqual(otherSettings);
		expect(app.radio.centerFreq).toBe(100);
	});
	it.each([
		{ key: 'ArrowLeft', start: 90.2, edge: 90, viewCentre: 92.5, offset: 0 },
		{ key: 'ArrowRight', start: 109.8, edge: 110, viewCentre: 107.5, offset: 0.75 },
	])(
		'clamps the view at the captured band edge when using $key, retuning only beyond it',
		async ({ key: direction, start, edge, viewCentre, offset }) => {
			const app = receiver();
			app.vfos[0].freq = start;
			app.view.zoomOffset = offset;
			for (let i = 0; i < 2; i++) {
				await key(document, direction);
				expect(app.view.zoomOffset).toBe(offset);
				expect((app.minFreq + app.maxFreq) / 2).toBe(viewCentre);
				expect(app.radio.centerFreq).toBe(100);
				expect(app.view.zoomScale).toBe(4);
			}
			expect(app.vfos[0].freq).toBe(edge);
			await key(document, direction);
			expect(app.radio.centerFreq).toBe(app.vfos[0].freq);
			expect(app.radio.centerFreq).not.toBe(100);
		},
	);
	it('preserves mouse-centred wheel zoom through the shared zoom action', () => {
		const app = receiver();
		const canvas = app.$refs.fft;
		canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, clientX: 250, cancelable: true }));
		expect(app.view.zoomScale).toBeCloseTo(4.4);
		expect(app.view.zoomOffset + 0.25 / app.view.zoomScale).toBeCloseTo(0.4375);
	});
	it('respects physical frequency bounds while allowing explicit tuning with display lock enabled', async () => {
		const app = receiver();
		app.radio = { ...app.radio, centerFreq: 0.2, sampleRate: 3200000 };
		app.view.locked = true;
		app.vfos[0].freq = 0.05;
		app.vfos[0].snapInterval = 100000;
		await key(document, 'ArrowLeft');
		expect(app.vfos[0].freq).toBe(0.05);
		await key(document, 'ArrowRight');
		expect(app.vfos[0].freq).toBe(0.15);
	});
	it('leaves form controls, menus, modified keys, composition and Tab alone', async () => {
		const app = receiver();
		const input = document.createElement('input');
		app.$el.append(input);
		input.focus();
		expect((await key(input, 'ArrowUp')).defaultPrevented).toBe(false);
		expect((await key(input, '/')).defaultPrevented).toBe(false);
		const menu = document.createElement('div');
		menu.className = 'ui-menu';
		app.$el.append(menu);
		expect((await key(menu, 'ArrowUp')).defaultPrevented).toBe(false);
		app.$refs.fft.focus();
		for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
			expect((await key(app.$refs.fft, 'ArrowUp', options)).defaultPrevented).toBe(false);
		}
		expect((await key(app.$refs.fft, 'Tab')).defaultPrevented).toBe(false);
		expect(app.view.zoomScale).toBe(4);
		expect(app.showMsg).not.toHaveBeenCalled();
	});
	it('ignores shortcuts under an open modal or on an unselected receiver', async () => {
		const workspace = { selectedId: 'second' };
		const first = receiver('first', workspace);
		const second = receiver('second', workspace);
		await key(document, 'ArrowUp');
		expect(second.view.zoomScale).toBeCloseTo(4.4);
		expect(first.view.zoomScale).toBe(4);
		const modal = document.createElement('div');
		modal.setAttribute('aria-modal', 'true');
		second.$el.append(modal);
		expect((await key(second.$refs.waterfall, 'ArrowUp')).defaultPrevented).toBe(false);
		expect((await key(second.$refs.waterfall, ']')).defaultPrevented).toBe(false);
	});
	it('removes the document listener on teardown', async () => {
		const app = receiver();
		app._canvasCleanup();
		expect((await key(document, 'ArrowUp')).defaultPrevented).toBe(false);
	});
	it('uses normal tuning conflict handling at band edges and protects replay and gain adjustment', async () => {
		const app = receiver();
		app.radio.sampleRate = 2000000;
		app.vfos = [makeDefaultVfo(99.1), makeDefaultVfo(100.9)];
		app.vfos.forEach((vfo) => {
			vfo.enabled = true;
			vfo.snapInterval = 500000;
		});
		app.activeVfoIndex = 1;
		await key(document, 'ArrowRight');
		expect(app.vfoConflictDialog).toMatchObject({ show: true, requestedFreq: 101.4, previousFreq: 100.9 });
		app.iqReplay = {} as NonNullable<typeof app.iqReplay>;
		await key(document, 'ArrowRight');
		expect(app.vfos[1].freq).toBe(100.9);
		expect(app.showMsg).toHaveBeenLastCalledWith('Frequency is outside the recorded bandwidth');
		app.iqReplay = null;
		app.autoGain.active = true;
		await key(document, 'ArrowLeft');
		expect(app.vfos[1].freq).toBe(100.9);
	});
});

describe('keyboard frequency bookmark cycling', () => {
	it('cycles with brackets without a canvas click and leaves slash and backslash unbound', async () => {
		const app = receiver();
		app.$refs.fft.blur();
		app.bookmarks = [bookmark(100.5), bookmark(101)];
		expect((await key(document, '/')).defaultPrevented).toBe(false);
		expect((await key(document, '\\')).defaultPrevented).toBe(false);
		expect(app.vfos[0].freq).toBe(100);
		await key(document, ']');
		expect(app.vfos[0].freq).toBe(100.5);
		await key(document, ']', { repeat: true });
		expect(app.vfos[0].freq).toBe(100.5);
		await key(document, ']');
		expect(app.vfos[0].freq).toBe(101);
		await key(document, '[');
		expect(app.vfos[0].freq).toBe(100.5);
	});
	it('follows category/frequency order, skips group presets and wraps in both directions', async () => {
		const app = receiver();
		app.bookmarks = [
			bookmark(102),
			bookmark(101, 'High', 'aviation'),
			{ type: 'group', name: 'Group', centerFreq: 500 },
			bookmark(100.5, 'Low', 'aviation'),
		];
		const otherVfo = makeDefaultVfo(99);
		const otherSettings = { ...otherVfo };
		app.vfos.push(otherVfo);
		for (const frequency of [100.5, 101, 102, 100.5]) {
			await key(app.$refs.fft, ']');
			expect(app.vfos[0].freq).toBe(frequency);
		}
		await key(app.$refs.fft, '[');
		expect(app.vfos[0].freq).toBe(102);
		expect(app.vfos[1]).toEqual(otherSettings);
		expect(app.radio.sampleRate).toBe(20000000);
		expect(app.radio.centerFreq).toBe(100);
		expect(app.showMsg).toHaveBeenLastCalledWith('Tuned to "102" — 102 MHz');
	});
	it('tracks duplicate frequencies per VFO and resets after manual tuning, deletion or filtering', async () => {
		const app = receiver();
		app.bookmarks = [bookmark(100, 'AM'), { ...bookmark(100, 'FM'), mode: 'wfm' }, bookmark(101, 'Next')];
		app.bookmarks[0].mode = 'am';
		await key(app.$refs.fft, ']');
		expect(app.showMsg).toHaveBeenLastCalledWith('Tuned to "FM" — 100 MHz');
		await key(app.$refs.fft, ']');
		expect(app.vfos[0].freq).toBe(101);
		app.vfos.push(makeDefaultVfo(100));
		app.activeVfoIndex = 1;
		await key(app.$refs.fft, ']');
		expect(app.vfos[1].mode).toBe('wfm');
		app.vfos[1].freq = 105;
		await key(app.$refs.fft, ']');
		expect(app.vfos[1].mode).toBe('am');
		app.bookmarks.splice(0, 1);
		await key(app.$refs.fft, ']');
		expect(app.vfos[1].freq).toBe(101);
		app.bookmarkSearch = 'FM';
		await key(app.$refs.fft, '[');
		expect(app.vfos[1].mode).toBe('wfm');
		expect(app.vfos[0].freq).toBe(101);
	});
	it('recalls all saved VFO settings, permits explicit retuning and ignores held bracket keys', async () => {
		const app = receiver();
		app.bookmarks = [{ ...bookmark(433.92), mode: 'nfm', bandwidth: 12500, squelchEnabled: true, volume: 25 }];
		await key(app.$refs.fft, ']', { repeat: true });
		expect(app.radio.centerFreq).toBe(100);
		await key(app.$refs.fft, ']');
		expect(app.radio.centerFreq).toBe(434);
		expect(app.vfos[0]).toMatchObject({ freq: 433.92, mode: 'nfm', bandwidth: 12500, squelchEnabled: true, volume: 25, enabled: true });
	});
	it.each(['locked remote', 'IQ replay'])('skips bookmarks needing a retune for %s', async (mode) => {
		const app = receiver();
		if (mode === 'locked remote') {
			app.remoteMode = 'client';
			app.locks.centerFreq = true;
		} else app.iqReplay = {} as NonNullable<typeof app.iqReplay>;
		app.bookmarks = [bookmark(433.92), bookmark(101)];
		await key(app.$refs.fft, ']');
		expect(app.vfos[0].freq).toBe(101);
		expect(app.radio.centerFreq).toBe(100);
	});
	it('handles empty or invalid bookmark lists and a missing active VFO', async () => {
		const app = receiver();
		app.bookmarks = [bookmark(NaN), bookmark(-1), { type: 'group', name: 'Group' }];
		await key(app.$refs.fft, '[');
		expect(app.showMsg).toHaveBeenCalledWith('No matching frequency bookmarks available');
		expect(app.vfos[0].freq).toBe(100);
		app.vfos = [];
		await key(app.$refs.fft, ']');
		expect(app.showMsg).toHaveBeenCalledTimes(1);
	});
});
