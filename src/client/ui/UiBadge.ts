import { defineComponent, h, type PropType } from 'vue';

export const badgeVariants = { default: 'transcript-badge', recording: 'transcript-badge recording', transcribing: 'transcript-badge transcribing', loading: 'transcript-badge loading', error: 'transcript-badge error', frequency: 'bm-badge bm-badge-freq', group: 'bm-badge bm-badge-group', category: 'bm-cat-badge', remote: 'remote-badge' } as const;
export default defineComponent({
	name: 'UiBadge', props: { variant: { type: String as PropType<keyof typeof badgeVariants>, default: 'default' } },
	setup(props, { slots }) { return () => h('span', { class: badgeVariants[props.variant] }, slots.default?.()); },
});
