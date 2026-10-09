import { describe, it, expect, vi } from 'vitest';
import { isReceiverCommand } from '@/remote/validation';
import { makeDefaultVfo } from '@/app/core/constants';
import { parseBookmarks } from '@/app/workspace/bookmark-data';
import { bookmarkMethods } from '@/app/workspace/bookmarks';

const report = {
	usbFps: 20,
	audioFps: 20,
	dspAvgMs: '2.00',
	dspMaxMs: '3.00',
	audioRate: 48000,
	inputRate: 2000000,
	dropped: 0,
	chunkSize: 16384,
};

describe('remote command boundaries', () => {
	it('accepts source continuity reports and rejects invalid source counters', () => {
		const stats = { ...report, sourceGapCount: 2, sourceMissingSamples: 2040, sourceDiscontinuities: 0 };
		expect(isReceiverCommand({ type: 'dspStats', stats })).toBe(true);
		for (const field of [
			'sourceGapCount',
			'sourceMissingSamples',
			'sourceDiscontinuities',
			'sourceGapWithinTransfer',
			'sourceGapBetweenTransfers',
			'sourceLargestGapSamples',
			'sourceLastGapArrivalMs',
			'sourceLastGapPreviousServiceMs',
			'usbArrivalMaxMs',
			'usbServiceAvgMs',
			'usbServiceMaxMs',
			'usbOutOfOrderTransfers',
			'usbLinkBits',
			'usbTransferBytes',
			'usbDiagnosticMode',
			'usbTransferCount',
			'usbReceivedBytes',
			'usbReceivedSamples',
			'usbElapsedMs',
			'usbLastTransferBytes',
		]) {
			for (const invalid of [NaN, Infinity, '2']) {
				expect(isReceiverCommand({ type: 'dspStats', stats: { ...stats, [field]: invalid } })).toBe(false);
			}
		}
	});
	it.each(['sync', 'receivers'])('requires a finite numeric frequency shift in %s radio state', (type) => {
		const command = (frequencyShift) => {
			const radio = { centerFreq: 100, sampleRate: 2000000, fftSize: 65536, frequencyShift };
			return type === 'sync'
				? { type, radio }
				: { type, receivers: [{ id: 'radio', name: 'SDR', running: true, radio, gains: {}, locks: {} }] };
		};
		for (const value of [undefined, '0', {}, null, NaN, Infinity, -Infinity]) expect(isReceiverCommand(command(value))).toBe(false);
		for (const value of [0, -125, 125]) expect(isReceiverCommand(command(value))).toBe(true);
	});
	it.each([
		['ps', true],
		['rt', 1],
		['pi', false],
		['ptyLabel', {}],
		['pty', 'music'],
		['pty', Infinity],
		['tp', 'yes'],
		['ta', 1],
	])('rejects RDS field %s with invalid value %s', (field, value) => {
		expect(isReceiverCommand({ type: 'rds', vfoIndex: 0, freq: 100, msg: { [field]: value } })).toBe(false);
	});
	it('accepts valid partial RDS updates and rejects invalid VFO indices', () => {
		const command = {
			type: 'rds',
			vfoIndex: 0,
			freq: 100,
			msg: { ps: 'Station', rt: '', pi: 'ABCD', pty: 0, ptyLabel: 'None', tp: false, ta: true },
		};
		expect(isReceiverCommand(command)).toBe(true);
		expect(isReceiverCommand({ ...command, msg: { ps: 'Station' } })).toBe(true);
		for (const index of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])
			expect(isReceiverCommand({ ...command, vfoIndex: index })).toBe(false);
	});
	it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])('rejects invalid remote VFO index %s', (index) => {
		expect(isReceiverCommand({ type: 'vfoUpdate', index, params: makeDefaultVfo() })).toBe(false);
		expect(isReceiverCommand({ type: 'removeRemoteVfo', index })).toBe(false);
	});
	it('accepts host performance reports without local squelch arrays', () => {
		expect(isReceiverCommand({ type: 'dspStats', stats: report })).toBe(true);
		expect(isReceiverCommand({ type: 'dspStats', stats: { ...report, squelchOpen: ['yes'] } })).toBe(false);
		expect(isReceiverCommand({ type: 'dspStats', stats: { ...report, dspAvgMs: {} } })).toBe(false);
	});
	it('requires a complete VFO contract and finite frequencies', () => {
		const params = makeDefaultVfo();
		expect(isReceiverCommand({ type: 'vfoUpdate', index: 0, params })).toBe(true);
		expect(isReceiverCommand({ type: 'vfoUpdate', index: 0, params: { ...params, squelchEnabled: 'yes' } })).toBe(false);
		expect(isReceiverCommand({ type: 'vfoUpdate', index: 0, params: { ...params, freq: Infinity } })).toBe(false);
	});
	it('rejects invalid capabilities and sensor discriminators', () => {
		expect(
			isReceiverCommand({ type: 'sync', capabilities: { deviceType: 'hackrf', sampleRates: [], gainControls: [], sampleFormat: 'int8' } }),
		).toBe(true);
		expect(isReceiverCommand({ type: 'sync', capabilities: { deviceType: 'hackrf', sampleRates: 'bad' } })).toBe(false);
		expect(
			isReceiverCommand({ type: 'rtl433', vfoIndex: 0, freq: 100, msg: { type: 'rtl433_event', freq: 100, event: { model: 'sensor' } } }),
		).toBe(true);
		expect(isReceiverCommand({ type: 'rtl433', vfoIndex: 0, freq: 100, msg: {} })).toBe(false);
	});
});
describe('bookmark data boundaries', () => {
	it.each(['1e400', '-1e400', '"2000000"', '{}', 'null'])('rejects malformed group sample rate %s', (literal) => {
		expect(() => parseBookmarks(`[{"name":"Group","centerFreq":100,"sampleRate":${literal}}]`)).toThrow();
	});
	it('preserves a valid group sample rate and permits legacy groups without one', () => {
		expect(parseBookmarks('[{"name":"Group","sampleRate":2000000}]')[0].sampleRate).toBe(2000000);
		expect(parseBookmarks('[{"name":"Group"}]')[0].sampleRate).toBeUndefined();
	});
	it.each([
		[-1, 0],
		[0.5, 0],
		[2, 0],
		[undefined, 0],
		[1, 1],
	])('loads a stored bookmark with index %s into valid slot %s', async (activeVfoIndex, expected) => {
		const app = {
			bookmarks: [{ name: 'Group', centerFreq: 100, vfos: [makeDefaultVfo(99), makeDefaultVfo(101)], activeVfoIndex }],
			radio: {},
			formatFreq: String,
			showMsg: vi.fn(),
		};
		await bookmarkMethods.jumpToBookmark.call(app, 0);
		expect(app.activeVfoIndex).toBe(expected);
		expect(app.vfos[app.activeVfoIndex]).toBeDefined();
	});
	it.each([-1, 0.5, 1, '0'])('rejects an invalid active bookmark index %s', (activeVfoIndex) => {
		expect(() => parseBookmarks(JSON.stringify([{ name: 'Group', vfos: [makeDefaultVfo()], activeVfoIndex }]))).toThrow();
	});
	it('accepts a valid selection and rejects an empty group or selection without VFOs', () => {
		expect(parseBookmarks(JSON.stringify([{ name: 'Group', vfos: [makeDefaultVfo()], activeVfoIndex: 0 }]))[0].activeVfoIndex).toBe(0);
		expect(() => parseBookmarks('[{"name":"Group","vfos":[]}]')).toThrow();
		expect(() => parseBookmarks('[{"name":"Group","activeVfoIndex":0}]')).toThrow();
	});
	it('preserves legacy group metadata and fills individual VFO defaults', () => {
		expect(parseBookmarks('[{"id":"saved","name":"Saved"}]')).toEqual([{ type: 'group', id: 'saved', name: 'Saved' }]);
		expect(parseBookmarks('[{"name":"Station","type":"individual","freq":102}]')[0]).toMatchObject({
			freq: 102,
			mode: 'wfm',
			enabled: false,
		});
	});
	it('rejects malformed primitive fields instead of restoring unsafe values', () => {
		expect(() => parseBookmarks('[{"name":"Station","type":"individual","freq":102,"volume":"loud"}]')).toThrow();
		expect(() => parseBookmarks('[{"name":"Group","vfos":{}}]')).toThrow();
	});
});
