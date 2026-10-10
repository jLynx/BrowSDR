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
					status: [{ state: 'receiving', message: 'Listening', samples: 0, frames: 16 }],
					sources: [
						{
							freq: 131.45,
							messages: [
								sample(1, '10', 'OFF090746,NZAA,ZBAA,190700,*,LT,0800,090736'),
								sample(2, 'SA', '0EV074755VS/'),
								sample(3, '_d', ''),
								sample(14, 'H1', '#MDB/BDOCAYA.ADS.A7-ANR073759D0C997088B86BC1F0D377770C71C488B805B38E698AB9AC88B80A626'),
								{
									...sample(15, 'H1', '#MDB/BDOCAYA.ADS.A7-ANR073759D0C99708'),
									registration: 'A7-ANR',
									messageNumber: 'D15A',
									blockId: '8',
									continuation: true,
								},
								{
									...sample(16, 'H1', '#MDB8B86BC1F0D377770C71C488B805B38E698AB9AC88B80A626'),
									registration: 'A7-ANR',
									messageNumber: 'D15B',
									blockId: '9',
									receivedAt: Date.parse('2026-10-09T07:50:02Z'),
								},
								{
									...sample(4, 'H1', '- #MD/AA AKLCDYA.CR1.NZ7013209F14E8E75AB53C06BF'),
									direction: 'uplink',
									registration: 'NZ7013',
									flight: undefined,
								},
								sample(5, 'H1', '#DFB<402>HER\n9   2 B-1466CCA568    PO 379091026073614NZAAZBAA43856\nCCA3AACMFC001  19 1023  19'),
								sample(6, 'H1', '<script>unparsed radio text</script>&#xA;'),
								sample(7, 'H1', 'L95AQF0073/KSFO.TI2/030KSFOAFF5C'),
								{
									...sample(
										12,
										'H1',
										'#DFBA380000047,1,1,TB000000;REP020,01;H0102001400000005.A6-EVQ10091026082944070;H02NZAA OMDBUAE5AM    S0586S0785RTRRV11D09;H03Normal Landing Gear Retraction;A1008292310;A20+0',
									),
									registration: 'A6-EVQ',
									flight: 'UAE5AM',
									messageNumber: 'U62A',
									continuation: true,
								},
								{
									...sample(13, 'H1', '#DFB0000010005+00000000006;A21+00000010036+00000000038;A22+00000010005+00000000006'),
									registration: 'A6-EVQ',
									flight: 'UAE5AM',
									messageNumber: 'U62B',
									continuation: true,
									receivedAt: Date.parse('2026-10-09T07:50:01Z'),
								},
								sample(8, '4A', 'DOOR/FWDENTRY CLSD 1440'),
								sample(9, '12', 'POSN 390104W 754601,-------,1244,1446,,-  4,23249  12,FOB   73,ETA 1303,KATL,KPHL,'),
								sample(10, 'H1', 'FLR/FR24030411230034583106FWC2 :NO DATA FROM GPS1 /IDECAM 2 ,ECAM 1 '),
								sample(
									11,
									'H1',
									'EZF\nNO0246/10/EI-NEO\n/C28Y331/3/9\n-SCT/MXP-ZNZ\n-STD/2200\n-FLT STATUS/CLOSED\n-UOM/KG\n-ZFW/162075\n-PAX/305\n-PXT/122/160/19/02\n-PXW/22601\n-CGO/3573\n-BAG/4783\n-OTH/4336\n-TTL/35293\n-FWT/51063\n-TOW/213138\n-DOW/126782',
								),
							],
						},
					],
				},
				toggleAcarsPanel: () => {},
				updateBackendVfoParams: () => {},
				tuneAcarsVfo: () => {},
				acarsStatusText: () => 'Listening · 16 valid frames',
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
		await expect(canvas.getAllByRole('row')).toHaveLength(5);
		await userEvent.click(canvas.getAllByRole('button', { name: 'B-1466' })[0]);
		await expect(canvas.getByLabelText('Message interpretation')).toBeVisible();
		await expect(canvas.getByText('2026-10-09 07:46:00 UTC')).toBeVisible();
		await expect(canvas.getByText('OFF090746,NZAA,ZBAA,190700,*,LT,0800,090736', { exact: true })).toBeVisible();
	},
};
export const DocumentedFormats: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText('Search ACARS messages'), 'Door event report');
		await userEvent.click(canvas.getByRole('button', { name: 'B-1466' }));
		await expect(canvas.getByText('DOOR/FWDENTRY CLSD 1440', { exact: true })).toBeVisible();
		await expect(canvas.getByText('14:40:00 UTC (date not supplied)', { exact: true })).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: 'Back to messages' }));
		await userEvent.clear(canvas.getByLabelText('Search ACARS messages'));
		await userEvent.type(canvas.getByLabelText('Search ACARS messages'), 'Load Sheet');
		await userEvent.click(canvas.getByRole('button', { name: 'B-1466' }));
		await expect(canvas.getByText('162075', { exact: true })).toBeVisible();
	},
};
export const ReassembledReport: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText('Search ACARS messages'), 'A7-ANR');
		await userEvent.click(canvas.getAllByRole('button', { name: 'A7-ANR' })[0]);
		await expect(canvas.getByText('Reassembled message', { exact: true })).toBeVisible();
		await expect(canvas.getByText('A626 · Verified', { exact: true })).toBeVisible();
		await expect(canvas.getByText('Decoded format', { exact: true })).toBeVisible();
	},
};
export const AircraftEvent: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText('Search ACARS messages'), 'Normal Landing Gear Retraction');
		await userEvent.click(canvas.getAllByRole('button', { name: 'A6-EVQ' })[0]);
		await expect(canvas.getByText('Related report identified · measurements undecoded', { exact: true })).toBeVisible();
		await expect(canvas.getByText('Normal Landing Gear Retraction', { exact: true })).toBeVisible();
		await expect(
			canvas.getByText(
				'Report context comes from separately received block U62A, matched by aircraft, source and message number within two minutes.',
				{ exact: true },
			),
		).toBeVisible();
	},
};
export const BinaryReports: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(canvas.getByLabelText('Search ACARS messages'), 'ADS-C position');
		await userEvent.click(canvas.getByRole('button', { name: 'B-1466' }));
		await expect(canvas.getByText('Decoded format', { exact: true })).toBeVisible();
		await expect(canvas.getByText('A626 · Verified', { exact: true })).toBeVisible();
		await expect(canvas.getByText('Latitude', { exact: true })).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: 'Back to messages' }));
		await userEvent.clear(canvas.getByLabelText('Search ACARS messages'));
		await userEvent.type(canvas.getByLabelText('Search ACARS messages'), 'CPDLC');
		await userEvent.click(canvas.getByRole('button', { name: 'NZ7013' }));
		await expect(canvas.getAllByText('NZZO Label A', { exact: true })).toHaveLength(2);
	},
};
