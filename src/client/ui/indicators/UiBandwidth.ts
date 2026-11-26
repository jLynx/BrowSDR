import { defineComponent, h } from 'vue';
import UiFormRow from '@/ui/layout/UiFormRow';

export function formatBandwidth(bytesPerSecond: number): string {
	const bits = Math.max(0, bytesPerSecond) * 8;
	return bits >= 1e6 ? `${(bits / 1e6).toFixed(2)} Mbps` : `${(bits / 1000).toFixed(1)} kbps`;
}

/** Presentation only: the transport owns measurement and polling. */
export default defineComponent({
	name: 'UiBandwidth',
	props: {
		uploadBps: { type: Number, default: 0 },
		downloadBps: { type: Number, default: 0 },
		peers: { type: Number, default: 0 },
		ready: Boolean,
		unavailable: Boolean,
		host: Boolean,
	},
	setup(props) {
		const value = (rate: number) => (props.unavailable ? 'Unavailable' : props.ready ? formatBandwidth(rate) : 'Measuring…');
		const row = (upload: boolean) =>
			h(UiFormRow, { label: upload ? 'Live upload' : 'Live download' }, () =>
				h('span', { class: 'remote-bandwidth-value' }, value(upload ? props.uploadBps : props.downloadBps)),
			);
		return () =>
			h(
				'div',
				{
					class: 'remote-bandwidth',
					'aria-label': 'Live sharing bandwidth',
					title: 'Measured sharing traffic, including IQ/audio, waterfall and control messages. Updated every second.',
				},
				[
					row(props.host),
					row(!props.host),
					h(
						'p',
						{ class: 'remote-bandwidth-caption' },
						props.host
							? `${props.peers} ${props.peers === 1 ? 'client' : 'clients'} · total across all SDRs`
							: 'Total across received SDRs',
					),
				],
			);
	},
});
