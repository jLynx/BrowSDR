import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createAppData } from '@/app/core/state';
import { makeDefaultVfo } from '@/app/core/constants';
import { acarsExport } from '@/app/decoders/acars/export';
import AcarsPanel from '@/app/decoders/acars/panel';
import type { AcarsRecord } from '@/worker/decoders/acars/types';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const message = (id: number, text = ''): AcarsRecord => ({
	id,
	receivedAt: Date.parse('2026-10-09T21:00:00Z') + id * 1000,
	registration: 'B-228J',
	flight: 'CZ0336',
	mode: '2',
	label: 'H1',
	acknowledgement: 'NAK',
	blockId: String(id % 10),
	direction: 'downlink',
	messageNumber: `D04${String.fromCharCode(64 + id)}`,
	continuation: false,
	text,
});

function receiverData() {
	const data = createAppData();
	data.vfos = [
		{ ...makeDefaultVfo(131.45), acars: true },
		{ ...makeDefaultVfo(131.55), acars: true },
	];
	data.acars.panelOpen = true;
	return {
		...data,
		acarsStatusText: () => 'Listening',
		toggleAcarsPanel: () => {},
		updateBackendVfoParams: () => {},
		tuneAcarsVfo: () => {},
	};
}

describe('ACARS batch export', () => {
	it('preserves exact original envelopes, empty acknowledgements and assembled text across VFOs', () => {
		const receiver = receiverData();
		const first = { ...message(1, '#DFBUNKNOWN\r\n<script>&$'), continuation: true };
		const last = message(2, '#DFB+123\n456');
		const ack = { ...message(3), label: '_d', messageNumber: undefined, acknowledgement: '6', direction: 'uplink' as const };
		receiver.acars.sources = [
			{ freq: 131.45, messages: [first, last] },
			{ freq: 131.55, messages: [ack] },
		];
		const snapshot = JSON.stringify(receiver.acars.sources);
		const data = JSON.parse(JSON.stringify(acarsExport(receiver, new Date('2026-10-09T21:05:00Z'))));
		expect(data).toMatchObject({ format: 'browsdr-acars-export', version: 1, blockCount: 3, exportedAtUtc: '2026-10-09T21:05:00.000Z' });
		expect(data.sources[0].messages[0]).toMatchObject({ ...first, blockEnding: 'ETB', receivedAtUtc: '2026-10-09T21:00:01.000Z' });
		expect(data.sources[0].messages[1].assembledText).toBe('#DFBUNKNOWN\r\n<script>&$+123\n456');
		expect(data.sources[0].messages[1].interpretation.notes.join(' ')).toContain('Reassembled 2 consecutive blocks');
		expect(data.sources[1]).toMatchObject({ vfoIndex: 1, vfoNumber: 2, frequencyMHz: 131.55 });
		expect(data.sources[1].messages[0]).toMatchObject({ ...ack, messageNumber: null, blockEnding: 'ETX' });
		expect(JSON.stringify(receiver.acars.sources)).toBe(snapshot);
	});
	it('exports all retained logs beyond the viewer limit, including disabled source logs', () => {
		const receiver = receiverData();
		receiver.vfos[1].acars = false;
		receiver.acars.sources = [
			{ freq: 131.45, messages: Array.from({ length: 150 }, (_, id) => message(id + 1)) },
			{ freq: 131.55, messages: Array.from({ length: 150 }, (_, id) => message(id + 1)) },
		];
		const data = acarsExport(receiver);
		expect(data.blockCount).toBe(300);
		expect(data.sources[1].decoderEnabled).toBe(false);
		expect(data.sources[1].messages).toHaveLength(150);
	});
	it('downloads all logs when search hides every row, preserving the current filter and source', async () => {
		const receiver = receiverData();
		receiver.acars.sources = [{ freq: 131.45, messages: [message(1, '#DFB123\n456')] }];
		wrapper = mount(AcarsPanel, { global: { provide: { receiver } } });
		await wrapper.get('[aria-label="Search ACARS messages"]').setValue('no-match');
		expect(wrapper.find('tbody').exists()).toBe(false);
		const createObjectURL = vi.fn(() => 'blob:acars-test');
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
		let filename = '';
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
			filename = this.download;
		});
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Export all JSON')!
			.trigger('click');
		expect(filename).toMatch(/^acars-.*\.json$/);
		const blob = createObjectURL.mock.calls[0][0] as Blob;
		const contents = await new Promise<string>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsText(blob);
		});
		expect(JSON.parse(contents).sources[0].messages[0].text).toBe('#DFB123\n456');
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:acars-test');
		expect((wrapper.get('[aria-label="Search ACARS messages"]').element as HTMLInputElement).value).toBe('no-match');
		expect(receiver.acars.sources[0]?.messages).toHaveLength(1);
	});
	it('disables export when no retained blocks exist', async () => {
		wrapper = mount(AcarsPanel, { global: { provide: { receiver: receiverData() } } });
		await nextTick();
		expect(
			wrapper
				.findAll('button')
				.find((button) => button.text() === 'Export all JSON')!
				.attributes('disabled'),
		).toBeDefined();
	});
});
