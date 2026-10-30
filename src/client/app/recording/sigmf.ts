import type { RecordingFormat } from '@/radio/iq/types';
import type { AppInstance } from '@/app/core/receiver.types';

export function sigmfMetadata(
	radio: AppInstance['radio'],
	gains: AppInstance['gains'],
	started: string,
	missingSamples: number | null,
	format: RecordingFormat = 'ci8',
	precisionBits = 8,
): string {
	return JSON.stringify(
		{
			global: {
				'core:datatype': format,
				'core:sample_rate': radio.sampleRate,
				'core:version': '1.2.6',
				'core:recorder': 'BrowSDR',
				'core:description': 'Raw signed I/Q; I first, Q second. Full receiver bandwidth.',
				'browsdr:gains': gains,
				'browsdr:iq_precision_bits': format === 'ci8' ? 8 : precisionBits,
				'browsdr:frequency_shift_hz': radio.frequencyShift * 1e6,
				'browsdr:missing_samples': missingSamples,
			},
			captures: [{ 'core:sample_start': 0, 'core:frequency': (radio.centerFreq - radio.frequencyShift) * 1e6, 'core:datetime': started }],
			annotations: [],
		},
		null,
		2,
	);
}

export function formatIqSize(bytes: number): string {
	return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
