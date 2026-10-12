import type { AppInstance } from '@/app/core/receiver.types';
import { interpretAcarsLog } from './context';
import { interpretAcars } from './interpret';

/** Includes all retained source logs, independently of the viewer's filter/selection. */
export function acarsExport(receiver: Pick<AppInstance, 'acars' | 'vfos'>, exportedAt = new Date()) {
	const sources = receiver.acars.sources.flatMap((source, index) => {
		if (!source) return [];
		const interpreted = new Map(interpretAcarsLog(source.messages).map((message) => [message.id, message]));
		return [
			{
				vfoIndex: index,
				vfoNumber: index + 1,
				frequencyMHz: source.freq,
				currentFrequencyMHz: receiver.vfos[index]?.freq ?? null,
				decoderEnabled: receiver.vfos[index]?.acars ?? false,
				status: receiver.acars.status[index] ?? null,
				messages: source.messages.map((message) => ({
					...(interpreted.get(message.id) ?? { ...message, interpretation: interpretAcars(message) }),
					messageNumber: message.messageNumber ?? null,
					flight: message.flight ?? null,
					receivedAtUtc: new Date(message.receivedAt).toISOString(),
					blockEnding: message.continuation ? 'ETB' : 'ETX',
				})),
			},
		];
	});
	return {
		format: 'browsdr-acars-export',
		version: 1,
		exportedAtUtc: exportedAt.toISOString(),
		displayTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		blockCount: sources.reduce((count, source) => count + source.messages.length, 0),
		scope: 'All currently retained VFO logs, including acknowledgements and retransmissions. Search and selection do not limit export.',
		retention:
			'Each decoder retains up to 200 recent blocks. Earlier discarded blocks and logs lost on refresh or retuning are unavailable.',
		sources,
	};
}

export function downloadAcarsExport(receiver: Pick<AppInstance, 'acars' | 'vfos'>): void {
	const data = acarsExport(receiver);
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = `acars-${data.exportedAtUtc.slice(0, 19).replace(/:/g, '-')}.json`;
	document.body.append(link);
	try {
		link.click();
	} finally {
		link.remove();
		URL.revokeObjectURL(url);
	}
}
