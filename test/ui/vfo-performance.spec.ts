import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { dsdMethods } from '@/app/decoders/dsd';
import VfoPanel from '@/app/radio/vfo-panel';
import { makePerformanceVfos } from '../fixtures/multi-vfo';
import { ReceiverView } from './helpers/receiver-view';

let wrapper: VueWrapper;
afterEach(() => wrapper?.unmount());

function panelOwner(component: ComponentPublicInstance): number | undefined {
	for (let parent: ComponentPublicInstance | null = component; parent; parent = parent.$parent) {
		if (parent.$options.name === 'VfoPanel') return (parent.$props as { i: number }).i;
	}
}

describe('multi-VFO render isolation', () => {
	for (const collapsed of [false, true]) {
		it(`keeps 135 DSD updates local with all 27 panels ${collapsed ? 'collapsed' : 'expanded'}`, async () => {
			const panelUpdates: number[] = [];
			const owners: number[] = [];
			let receiverUpdates = 0;
			wrapper = mount(ReceiverView, {
				global: {
					mixins: [
						{
							updated(this: ComponentPublicInstance) {
								if (this === wrapper.vm) receiverUpdates++;
								if (this.$options.name === 'VfoPanel') panelUpdates.push((this.$props as { i: number }).i);
								// Include nested controls: recreating their slots can cause costly work
								// even when the enclosing panel's own update count looks reasonable.
								const owner = panelOwner(this);
								if (owner !== undefined) owners.push(owner);
							},
						},
					],
				},
			});
			const vfos = makePerformanceVfos();
			await wrapper.setData({
				vfos,
				connected: true,
				running: true,
				radio: { centerFreq: 439, sampleRate: 61440000 },
				collapsedPanels: Object.fromEntries(vfos.map((_, i) => [`vfo-${i}`, collapsed])),
			});
			panelUpdates.length = owners.length = receiverUpdates = 0;
			const panels = wrapper.findAllComponents(VfoPanel);
			expect(panels).toHaveLength(27);
			for (let round = 1; round <= 5; round++) {
				for (let i = 0; i < vfos.length; i++) {
					owners.length = 0;
					dsdMethods._onDsdStatus.call(wrapper.vm, i, {
						synced: true,
						mode: 'dmr',
						syncName: 'DMR_BS_VOICE',
						syncCount: round,
						voiceFrameCount: round * 6,
						mbelibLoaded: true,
					});
					// Separate flushes simulate independently arriving worker messages.
					// A single batched flush would hide the original amplification.
					await nextTick();
					expect([...new Set(owners)], `update for VFO ${i + 1}`).toEqual([i]);
				}
			}
			expect(panelUpdates).toEqual(Array.from({ length: 135 }, (_, i) => i % 27));
			expect(receiverUpdates).toBe(0);
			for (const panel of panels) {
				expect(panel.text()).toContain('DMR · 5 bursts');
				expect(panel.text()).toContain('Voice frames: 30');
			}
		});
	}

	it('keeps receiver stats, audio activity, and pointer updates out of VFO controls', async () => {
		const owners: number[] = [];
		wrapper = mount(ReceiverView, {
			global: {
				mixins: [
					{
						updated(this: ComponentPublicInstance) {
							const owner = panelOwner(this);
							if (owner !== undefined) owners.push(owner);
						},
					},
				],
			},
		});
		await wrapper.setData({ vfos: makePerformanceVfos(), connected: true, running: true, showStats: true });
		owners.length = 0;
		for (let frame = 0; frame < 20; frame++) {
			await wrapper.setData({
				fps: 60,
				dspStats: { inputRate: 61440000, usbFps: 930 + frame },
				hoverFreqText: `${439 + frame / 1000} MHz`,
				activityNow: frame * 500,
				vfoSquelchOpen: Array.from({ length: 27 }, (_, i) => i === frame % 27),
			});
		}
		expect(owners).toEqual([]);
		expect(wrapper.get('.dsp-stats-overlay').text()).toContain('949');
	});
});
