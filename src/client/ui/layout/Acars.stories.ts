import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, within } from 'storybook/test';
import { provide, reactive } from 'vue';
import AcarsPanel from '@/app/decoders/acars/panel';
import { createAppData } from '@/app/core/state';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';
import type { AcarsRecord } from '@/worker/decoders/acars/types';

function sample(id: number, label: string, text: string): AcarsRecord {
	return {
		id,
		label,
		text,
		receivedAt: Date.parse('2026-10-09T07:50:00Z') - id * 1000,
		registration: 'B-1466',
		flight: 'CA0568',
		mode: '2',
		acknowledgement: '3',
		blockId: '1',
		direction: 'downlink',
		continuation: false,
	};
}

const meta = {
	title: 'Receiver/ACARS Messages',
	component: AcarsPanel,
	render: () => ({
		components: { AcarsPanel },
		setup() {
			const data = createAppData();
			const receiver = reactive({
				...data,
				vfos: [{ ...makeDefaultVfo(131.45), acars: true }],
				running: true,
				acars: {
					...data.acars,
					panelOpen: true,
					status: [{ state: 'receiving', message: 'Listening', samples: 0, frames: 6 }],
					sources: [
						{
							freq: 131.45,
							messages: [
								sample(1, '10', 'OFF090746,NZAA,ZBAA,190700,*,LT,0800,090736'),
								sample(2, 'SA', '0EV074755VS/'),
								sample(3, '_d', ''),
								{
									...sample(4, 'H1', '- #MD/AA AKLCDYA.CR1.NZ7013209F14E8E75AB53C06BF'),
									direction: 'uplink',
									registration: 'NZ7013',
									flight: undefined,
								},
								sample(5, 'H1', '#DFB<402>HER\n9   2 B-1466CCA568    PO 379091026073614NZAAZBAA43856\nCCA3AACMFC001  19 1023  19'),
								sample(6, 'H1', '<script>unparsed radio text</script>&#xA;'),
							],
						},
					],
				},
				toggleAcarsPanel: () => {},
				updateBackendVfoParams: () => {},
				tuneAcarsVfo: () => {},
				acarsStatusText: () => 'Listening · 6 valid frames',
			});
			provide('receiver', receiver as unknown as AppInstance);
		},
		template: '<div><p>Sample ACARS messages for display review. This is not live reception.</p><AcarsPanel /></div>',
	}),
} satisfies Meta<typeof AcarsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Preview: Story = {};
export const ReadableReports: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText('Search ACARS messages'), 'Auckland');
		await expect(canvas.getAllByRole('row')).toHaveLength(3);
		await userEvent.click(canvas.getAllByRole('button', { name: 'B-1466' })[0]);
		await expect(canvas.getByLabelText('Message interpretation')).toBeVisible();
		await expect(canvas.getByText('2026-10-09 07:46:00 UTC')).toBeVisible();
		await expect(canvas.getByText('OFF090746,NZAA,ZBAA,190700,*,LT,0800,090736', { exact: true })).toBeVisible();
	},
};
