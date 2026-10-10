import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsInterpretation } from '@/app/decoders/acars/types';

/** Extracts a received arrival acknowledgement without assigning absent units or timezones. */
export function interpretUplink(message: AcarsRecord): AcarsInterpretation | undefined {
	if (message.direction !== 'uplink' || message.label !== 'C1' || message.text.length > 8192) return;
	const match = /^\.([A-Z0-9]{7}) +(\d{6}) +AGM +AN +([A-Z0-9-]+) +- +ARRIVAL +ACK +LD +(\d{4}) +RI +(\d{4}) +REMAIN +FUEL +(\d+)$/.exec(
		message.text.trim().replace(/\s+/g, ' '),
	);
	if (!match) return;
	const [, address, headerTime, registration, ld, ri, fuel] = match;
	if ([ld, ri].some((value) => Number(value.slice(0, 2)) > 23 || Number(value.slice(2)) > 59)) return;
	const clock = (value: string) => `${value.slice(0, 2)}:${value.slice(2)} · timezone unspecified`;
	return {
		title: 'Arrival acknowledgement',
		summary: `Arrival acknowledged for ${registration} · LD ${ld.slice(0, 2)}:${ld.slice(2)} · RI ${ri.slice(0, 2)}:${ri.slice(2)} · remaining fuel ${fuel} (units unspecified).`,
		coverage: 'partial',
		fields: [
			{ label: 'Reported event', value: 'ARRIVAL ACK · arrival acknowledgement' },
			{ label: 'Reported registration', value: registration },
			{ label: 'Ground address', value: address },
			{ label: 'Header time code (raw)', value: headerTime },
			{ label: 'LD time code', value: clock(ld) },
			{ label: 'RI time code', value: clock(ri) },
			{ label: 'Remaining fuel (raw)', value: `${fuel} · units unspecified` },
		],
		notes: [
			'This is a ground-to-air arrival acknowledgement. LD and RI are retained as transmitted time codes; their event meanings, date and timezone are not verified.',
			'The remaining fuel value has no reported unit or verified scale. The address and header time code are retained without inferring their organization or date.',
		],
	};
}
