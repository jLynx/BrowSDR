import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, nextTick, ref } from 'vue';
import { useBaseMap } from '@/app/decoders/rtk/map-view';
import type { RtcmReference } from '@/worker/decoders/rtk/types';

const maps = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), destroy: vi.fn(), resize: vi.fn() }));
vi.mock('leaflet', () => ({}));
vi.mock('@/app/decoders/rtk/map', () => ({
	BaseMap: class {
		constructor() {
			maps.create();
		}
		update = maps.update;
		destroy = maps.destroy;
		resize = maps.resize;
	},
}));

const position: RtcmReference = { stationId: 1, itrf: 0, latitude: 0, longitude: 0, heightM: 1, ecef: [1, 2, 3] };
const Harness = defineComponent({
	template: '<div v-if="mapVisible" ref="element"></div>',
	setup() {
		const open = ref(true),
			element = ref<HTMLElement>(),
			location = ref<RtcmReference | undefined>(position);
		return {
			open,
			location,
			element,
			...useBaseMap(
				() => open.value,
				element,
				computed(() => location.value),
				computed(() => 'base'),
				computed(() => 'UM960'),
			),
		};
	},
});
let wrapper: VueWrapper<InstanceType<typeof Harness>>;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});

describe('RTK map lifecycle', () => {
	it('removes maps on close or absent coordinates and recreates them on reopen', async () => {
		wrapper = mount(Harness);
		await vi.dynamicImportSettled();
		await flushPromises();
		expect(maps.create).toHaveBeenCalledOnce();
		expect(maps.update).toHaveBeenCalledWith(position, 'base', 'UM960');
		wrapper.vm.open = false;
		await nextTick();
		expect(maps.destroy).toHaveBeenCalledOnce();
		wrapper.vm.open = true;
		await nextTick();
		await vi.dynamicImportSettled();
		await flushPromises();
		expect(maps.create).toHaveBeenCalledTimes(2);
		wrapper.vm.location = undefined;
		await nextTick();
		expect(maps.destroy).toHaveBeenCalledTimes(2);
		expect(wrapper.find('div').exists()).toBe(false);
	});

	it('does not create a late-loading map after the panel unmounts', async () => {
		wrapper = mount(Harness);
		wrapper.unmount();
		await vi.dynamicImportSettled();
		await flushPromises();
		expect(maps.create).not.toHaveBeenCalled();
	});
});
