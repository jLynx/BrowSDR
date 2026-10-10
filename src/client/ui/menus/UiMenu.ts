import { defineComponent, h, onMounted, onBeforeUnmount, ref, type PropType } from 'vue';
import UiButton from '@/ui/controls/UiButton';
import UiChevron from '@/ui/indicators/UiChevron';
import UiIcon from '@/ui/indicators/UiIcon';
import type { UiMenuGroup } from './types';

/** Labeled action disclosure. Selection is emitted; application behavior stays with the caller. */
export default defineComponent({
	name: 'UiMenu',
	props: {
		id: { type: String, required: true },
		label: { type: String, default: 'Tools' },
		groups: { type: Array as PropType<UiMenuGroup[]>, required: true },
	},
	emits: ['select'],
	setup(props, { emit }) {
		const root = ref<HTMLElement>();
		const trigger = ref<InstanceType<typeof UiButton>>();
		const open = ref(false);
		const close = (restoreFocus = false) => {
			open.value = false;
			if (restoreFocus) (trigger.value?.$el as HTMLButtonElement | undefined)?.focus();
		};
		const outside = (event: PointerEvent) => {
			if (!root.value?.contains(event.target as Node)) close();
		};
		onMounted(() => document.addEventListener('pointerdown', outside));
		onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
		return () =>
			h(
				'div',
				{
					ref: root,
					class: 'ui-menu',
					onFocusout: (event: FocusEvent) => {
						if (!root.value?.contains(event.relatedTarget as Node)) close();
					},
					onKeydown: (event: KeyboardEvent) => {
						if (event.key === 'Escape' && open.value) {
							event.preventDefault();
							event.stopPropagation();
							close(true);
						}
					},
				},
				[
					h(
						UiButton,
						{
							ref: trigger,
							variant: 'icon',
							class: 'tools-trigger',
							'aria-expanded': open.value,
							'aria-controls': props.id,
							onClick: () => {
								open.value = !open.value;
							},
						},
						() => [props.label, h(UiChevron, { collapsed: !open.value, size: 14 })],
					),
					open.value
						? h(
								'div',
								{ id: props.id, class: 'ui-menu-list', 'aria-label': props.label },
								props.groups.map((group) =>
									h('div', { class: 'ui-menu-group', key: group.label, role: 'group', 'aria-label': group.label }, [
										h('div', { class: 'ui-menu-group-label' }, group.label),
										h(
											'div',
											{ class: 'ui-menu-items' },
											group.items.map((item) =>
												h(
													UiButton,
													{
														key: item.id,
														variant: 'icon',
														class: ['ui-menu-item', { active: item.active }],
														'aria-label': item.label,
														'aria-describedby': item.description ? `${props.id}-${item.id}-description` : undefined,
														'aria-pressed': !!item.open,
														onClick: () => {
															emit('select', item.id);
															close(true);
														},
													},
													() => [
														h(UiIcon, { name: item.icon }),
														h('span', { class: 'ui-menu-item-copy' }, [
															h('span', { class: 'ui-menu-item-label' }, item.label),
															item.description
																? h(
																		'span',
																		{ id: `${props.id}-${item.id}-description`, class: 'ui-menu-item-description' },
																		item.description,
																	)
																: null,
														]),
													],
												),
											),
										),
									]),
								),
							)
						: null,
				],
			);
	},
});
