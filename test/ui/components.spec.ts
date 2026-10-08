import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent } from 'vue';
import * as ui from '../../src/client/ui';

const wrappers: VueWrapper[] = [];
function render(template: string, data: Record<string, unknown> = {}) {
	const wrapper = mount(defineComponent({ components: ui, template, data: () => ({ ...data }) }), { attachTo: document.body });
	wrappers.push(wrapper);
	return wrapper;
}
afterEach(() => {
	wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('native control contracts', () => {
	it('preserves numeric native device toggles', async () => {
		const wrapper = render('<UiCheckbox variant="native" v-model="gain" :true-value="1" :false-value="0" label="Amp"/>', { gain: 0 });
		await wrapper.find('input').setValue(true);
		expect(wrapper.vm.gain).toBe(1);
		await wrapper.find('input').setValue(false);
		expect(wrapper.vm.gain).toBe(0);
		expect(wrapper.classes()).toContain('checkbox');
		expect(wrapper.find('.checkmark').exists()).toBe(false);
	});
	it('preserves numeric, empty, trim, and lazy input models', async () => {
		const wrapper = render('<UiInput type="number" v-model.number="number"/><UiInput v-model.trim="text"/><UiInput v-model.lazy="lazy"/>', {
			number: 100,
			text: '',
			lazy: '',
		});
		const inputs = wrapper.findAll('input');
		await inputs[0].setValue('106.5');
		expect(wrapper.vm.number).toBe(106.5);
		await inputs[0].setValue('');
		expect(wrapper.vm.number).toBe('');
		await inputs[1].setValue('  station  ');
		expect(wrapper.vm.text).toBe('station');
		(inputs[2].element as HTMLInputElement).value = 'draft';
		await inputs[2].trigger('input');
		expect(wrapper.vm.lazy).toBe('');
		await inputs[2].trigger('change');
		expect(wrapper.vm.lazy).toBe('draft');
	});
	it('forwards native events and attributes to inputs', async () => {
		const change = vi.fn();
		const wrapper = mount(ui.UiInput, { props: { modelValue: '100' }, attrs: { id: 'frequency', title: 'Frequency', onBlur: change } });
		wrappers.push(wrapper);
		await wrapper.trigger('blur');
		expect(change.mock.calls[0][0].target).toBe(wrapper.element);
		expect(wrapper.attributes()).toMatchObject({ id: 'frequency', title: 'Frequency' });
	});
	it('preserves numeric select values, dynamic options, and change event ordering', async () => {
		const wrapper = render(
			'<UiSelect v-model.number="rate" @change="observed = rate"><option v-for="value in rates" :key="value" :value="value">{{ value }}</option></UiSelect>',
			{ rate: 2, rates: [2, 20], observed: null },
		);
		await wrapper.find('select').setValue('20');
		expect(wrapper.vm.rate).toBe(20);
		expect(wrapper.vm.observed).toBe(20);
		await wrapper.setData({ rate: 4, rates: [4, 8] });
		expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('4');
	});
	it('updates checkbox models before the receiver change callback', async () => {
		const wrapper = render('<UiCheckbox v-model="enabled" label="Decode RDS" @change="observed = enabled"/>', {
			enabled: false,
			observed: false,
		});
		await wrapper.find('input').setValue(true);
		expect(wrapper.vm.enabled).toBe(true);
		expect(wrapper.vm.observed).toBe(true);
		expect(wrapper.find('.checkmark').exists()).toBe(true);
	});
	it('keeps radio groups independent for different receivers', async () => {
		const wrapper = render(
			'<UiRadio v-model="first" value="nfm" name="receiver-1">NFM</UiRadio><UiRadio v-model="first" value="wfm" name="receiver-1">WFM</UiRadio><UiRadio v-model="second" value="nfm" name="receiver-2">NFM</UiRadio>',
			{ first: 'nfm', second: 'nfm' },
		);
		await wrapper.findAll('input')[1].setValue(true);
		expect(wrapper.vm.first).toBe('wfm');
		expect(wrapper.vm.second).toBe('nfm');
		expect((wrapper.findAll('input')[2].element as HTMLInputElement).checked).toBe(true);
	});
	it('updates numeric sliders and respects spinbox bounds', async () => {
		const wrapper = render(
			'<UiSlider v-model="volume" :min="0" :max="100"/><UiSpinbox v-model="bandwidth" :step="1000" :min="1000" :max="3000"/>',
			{ volume: 50, bandwidth: 2000 },
		);
		await wrapper.find('input[type=range]').setValue('75');
		expect(wrapper.vm.volume).toBe(75);
		const buttons = wrapper.findAll('button');
		await buttons[1].trigger('click');
		await buttons[1].trigger('click');
		expect(wrapper.vm.bandwidth).toBe(3000);
		await buttons[0].trigger('click');
		await buttons[0].trigger('click');
		await buttons[0].trigger('click');
		expect(wrapper.vm.bandwidth).toBe(1000);
	});
	it('does not emit spinbox changes while disabled', async () => {
		const wrapper = mount(ui.UiSpinbox, { props: { modelValue: 12000, step: 1000, disabled: true } });
		wrappers.push(wrapper);
		await wrapper.findAll('button')[1].trigger('click');
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});
});

describe('composed UI behavior', () => {
	it('preserves button classes, slot markup and native disabled behavior', async () => {
		const click = vi.fn();
		const wrapper = mount(ui.UiButton, {
			props: { variant: 'primary' },
			attrs: { class: 'btn-full', onClick: click, disabled: true },
			slots: { default: '<span>Save</span>' },
		});
		wrappers.push(wrapper);
		expect(wrapper.element.tagName).toBe('BUTTON');
		expect(wrapper.classes()).toEqual(['btn', 'btn-primary', 'btn-full']);
		expect(wrapper.attributes('type')).toBe('button');
		expect(wrapper.find('span').text()).toBe('Save');
		await wrapper.trigger('click');
		expect(click).not.toHaveBeenCalled();
	});
	it('keeps panel contents mounted on collapse and supports keyboard toggling', async () => {
		const wrapper = render('<UiPanel label="Radio" v-model:collapsed="collapsed"><UiInput v-model="frequency"/></UiPanel>', {
			collapsed: false,
			frequency: '100',
		});
		const header = wrapper.find('[role=button]');
		const input = wrapper.find('input').element;
		await header.trigger('keydown', { key: 'Enter' });
		expect(wrapper.vm.collapsed).toBe(true);
		expect(wrapper.find('input').element).toBe(input);
		expect(wrapper.find('.panel-body').isVisible()).toBe(false);
		await header.trigger('keydown', { key: ' ' });
		expect(header.attributes('aria-expanded')).toBe('true');
	});
	it('does not toggle a panel when a nested action handles a key', async () => {
		const wrapper = render('<UiPanelHeader><UiButton>Mute</UiButton></UiPanelHeader>');
		await wrapper.find('button').trigger('keydown', { key: 'Enter' });
		expect(wrapper.findComponent(ui.UiPanelHeader).emitted('toggle')).toBeUndefined();
	});
	it('dismisses only the dialog backdrop and preserves slotted native refs', async () => {
		const wrapper = render(
			'<UiDialog :open="open" title="Save Bookmark" @close="open = false"><input ref="name"/><template #footer><UiButton>Save</UiButton></template></UiDialog>',
			{ open: true },
		);
		expect(wrapper.vm.$refs.name).toBe(wrapper.find('input').element);
		await wrapper.find('input').trigger('click');
		expect(wrapper.vm.open).toBe(true);
		await wrapper.find('.bookmark-dialog').trigger('click');
		expect(wrapper.vm.open).toBe(true);
		await wrapper.find('.bookmark-overlay').trigger('click');
		expect(wrapper.vm.open).toBe(false);
		expect(wrapper.find('[role=dialog]').exists()).toBe(false);
	});
	it('keeps conflict dialogs open on backdrop click', async () => {
		const wrapper = mount(ui.UiDialog, { props: { open: true, dismissible: false, title: 'Conflict' } });
		wrappers.push(wrapper);
		await wrapper.find('.bookmark-overlay').trigger('click');
		expect(wrapper.emitted('close')).toBeUndefined();
	});
	it('restricts remote locks to the host', async () => {
		const wrapper = mount(ui.UiLock, { props: { locked: true, host: false } });
		wrappers.push(wrapper);
		await wrapper.trigger('click');
		await wrapper.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted('toggle')).toBeUndefined();
		await wrapper.setProps({ host: true });
		await wrapper.trigger('keydown', { key: ' ' });
		expect(wrapper.emitted('toggle')).toHaveLength(1);
	});
	it('emits the native frequency input event for the existing apply handler', async () => {
		const wrapper = mount(ui.UiFrequencyDisplay, {
			props: {
				modelValue: '100.000000',
				index: 1,
				color: '#ff4444',
				receiving: true,
				outOfBand: true,
				enabled: false,
				bookmark: 'Station',
			},
		});
		wrappers.push(wrapper);
		await wrapper.find('input').trigger('keyup', { key: 'Enter' });
		expect((wrapper.emitted('apply')![0][0] as KeyboardEvent).target).toBe(wrapper.find('input').element);
		expect(wrapper.find('.vfo-rx-badge').text()).toBe('RX');
		expect(wrapper.find('.vfo-oob-badge').text()).toBe('OOB');
		expect(wrapper.find('.vfo-mute-badge').exists()).toBe(true);
		expect(wrapper.find('.vfo-bookmark-label').text()).toBe('Station');
	});
});
