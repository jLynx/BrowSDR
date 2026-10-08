import { describe, it, expect } from 'vitest';
import { isReceiverCommand } from '@/remote/validation';
import { makeDefaultVfo } from '@/app/core/constants';
import { parseBookmarks } from '@/app/workspace/bookmark-data';

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
