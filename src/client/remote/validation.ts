import { validBleMessage } from '@/worker/decoders/ble/validation';
import { validAisMessage } from '@/worker/decoders/ais/validation';
import { validAcarsMessage } from '@/worker/decoders/acars/validation';
import { validAdsbMessage } from '@/worker/decoders/adsb/validation';
import { isRecord, primitiveMap } from '@/platform/data';
import type { ReceiverCommand } from './types';

function numbers(value: unknown, fields: string[]): boolean {
	return isRecord(value) && fields.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

/** PeerJS data is untrusted until the command discriminator and payload agree. */
export function isReceiverCommand(value: unknown): value is ReceiverCommand {
	if (!isRecord(value) || (value.receiverId !== undefined && typeof value.receiverId !== 'string')) return false;
	return typeof value.type === 'string' && (validators[value.type]?.(value) ?? false);
}

const validators: Record<string, (value: Record<string, unknown>) => boolean> = {
	resetRemoteVfos: (_value: Record<string, unknown>) => true,
	addRemoteVfo: (_value: Record<string, unknown>) => true,
	removeRemoteVfo: (value: Record<string, unknown>) => validIndex(value.index),
	requestChange: (value: Record<string, unknown>) =>
		typeof value.target === 'string' && typeof value.property === 'string' && numbers(value, ['value']),
	clientInfo: (value: Record<string, unknown>) =>
		(value.country === undefined || typeof value.country === 'string') &&
		(value.deviceId === undefined || typeof value.deviceId === 'string'),
	clientDisplay: (value: Record<string, unknown>) => typeof value.sharedChannelization === 'boolean',
	squelchState: (value: Record<string, unknown>) =>
		Array.isArray(value.squelchOpen) && value.squelchOpen.every((item: unknown) => typeof item === 'boolean'),
	sync: (value: Record<string, unknown>) =>
		(value.radio === undefined || validRadio(value.radio)) &&
		(value.gains === undefined || primitiveMap<number>(value.gains, 'number')) &&
		(value.locks === undefined || primitiveMap<boolean>(value.locks, 'boolean')) &&
		validCapabilities(value.capabilities),
	receivers: (value: Record<string, unknown>) =>
		Array.isArray(value.receivers) &&
		value.receivers.every(
			(item: unknown) =>
				isRecord(item) &&
				typeof item.id === 'string' &&
				typeof item.name === 'string' &&
				typeof item.running === 'boolean' &&
				validRadio(item.radio) &&
				primitiveMap<number>(item.gains, 'number') &&
				primitiveMap<boolean>(item.locks, 'boolean') &&
				validCapabilities(item.capabilities),
		),
	vfoUpdate: (value: Record<string, unknown>) => validIndex(value.index) && validVfoParams(value.params),
	dspStats: (value) => validDspStats(value.stats),
	ble: (value: Record<string, unknown>) => validIndex(value.vfoIndex) && numbers(value, ['freq']) && validBleMessage(value.msg),
	ais: (value: Record<string, unknown>) => validIndex(value.vfoIndex) && numbers(value, ['freq']) && validAisMessage(value.msg),
	acars: (value: Record<string, unknown>) => validIndex(value.vfoIndex) && numbers(value, ['freq']) && validAcarsMessage(value.msg),
	adsb: (value: Record<string, unknown>) => validIndex(value.vfoIndex) && numbers(value, ['freq']) && validAdsbMessage(value.msg),
	rtl433: (value: Record<string, unknown>) => numbers(value, ['vfoIndex', 'freq']) && validSensorMessage(value.msg),
	pocsag: (value: Record<string, unknown>) =>
		numbers(value, ['vfoIndex', 'freq']) &&
		isRecord(value.msg) &&
		typeof value.msg.text === 'string' &&
		numbers(value.msg, ['capcode', 'func', 'baud']) &&
		['alpha', 'tone', 'numeric'].includes(String(value.msg.type)),
	rds: (value: Record<string, unknown>) => validIndex(value.vfoIndex) && numbers(value, ['freq']) && validRdsMessage(value.msg),
};

function validRadio(value: unknown): boolean {
	return numbers(value, ['centerFreq', 'frequencyShift', 'sampleRate', 'fftSize']);
}

function validRdsMessage(value: unknown): boolean {
	return (
		isRecord(value) &&
		optionalFields(value, ['ps', 'rt', 'pi', 'ptyLabel'], 'string') &&
		optionalFields(value, ['pty'], 'number') &&
		optionalFields(value, ['tp', 'ta'], 'boolean')
	);
}

function validIndex(value: unknown): boolean {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function typedFields(value: unknown, fields: string[], kind: string): boolean {
	return isRecord(value) && fields.every((key) => typeof value[key] === kind);
}
function optionalFields(value: Record<string, unknown>, fields: string[], kind: string): boolean {
	return fields.every(
		(key) => value[key] === undefined || (typeof value[key] === kind && (kind !== 'number' || Number.isFinite(value[key]))),
	);
}
function validVfoParams(value: unknown): boolean {
	return (
		numbers(value, ['freq', 'bandwidth', 'volume', 'squelchLevel']) &&
		isRecord(value) &&
		typedFields(value, ['mode', 'deEmphasis', 'rdsRegion'], 'string') &&
		typedFields(value, ['enabled', 'squelchEnabled', 'lowPass', 'highPass', 'pocsag', 'rds'], 'boolean') &&
		optionalFields(value, ['rtl433', 'audioMuted', 'adsb', 'ais', 'ble', 'acars'], 'boolean') &&
		optionalFields(value, ['rtl433SampleRate'], 'number') &&
		optionalFields(value, ['rtl433Protocols'], 'string')
	);
}
function validDspStats(value: unknown): boolean {
	if (!isRecord(value) || !numbers(value, ['usbFps', 'audioFps', 'audioRate', 'inputRate', 'dropped', 'chunkSize'])) return false;
	return (
		['dspAvgMs', 'dspMaxMs'].every(
			(key) => typeof value[key] === 'string' || (typeof value[key] === 'number' && Number.isFinite(value[key])),
		) &&
		(value.squelchOpen === undefined ||
			(Array.isArray(value.squelchOpen) && value.squelchOpen.every((item: unknown) => typeof item === 'boolean'))) &&
		(value.squelchDb === undefined ||
			(Array.isArray(value.squelchDb) && value.squelchDb.every((item: unknown) => typeof item === 'number' && Number.isFinite(item)))) &&
		(value.channelization === undefined || numbers(value.channelization, ['bands', 'vfos', 'sampleRate'])) &&
		optionalFields(
			value,
			[
				'msgRate',
				'whisperMsgRate',
				'channelAvgMs',
				'channelMaxMs',
				'channelCpuMs',
				'audioQueueMs',
				'droppedTotal',
				'sourceGapCount',
				'sourceMissingSamples',
				'sourceDiscontinuities',
				'sourceGapWithinTransfer',
				'sourceGapBetweenTransfers',
				'sourceLargestGapSamples',
				'sourceLastGapArrivalMs',
				'sourceLastGapPreviousServiceMs',
				'usbArrivalMaxMs',
				'usbServiceAvgMs',
				'usbServiceMaxMs',
				'usbOutOfOrderTransfers',
				'usbLinkBits',
				'usbTransferBytes',
				'usbDiagnosticMode',
				'usbTransferCount',
				'usbReceivedBytes',
				'usbReceivedSamples',
				'usbElapsedMs',
				'usbLastTransferBytes',
			],
			'number',
		) &&
		optionalFields(value, ['whisperEnabled'], 'boolean')
	);
}
function validCapabilities(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return (
		isRecord(value) &&
		typeof value.deviceType === 'string' &&
		Array.isArray(value.sampleRates) &&
		value.sampleRates.every((rate: unknown) => typeof rate === 'number' && Number.isFinite(rate)) &&
		['int8', 'uint8', 'int16', 'float32'].includes(String(value.sampleFormat)) &&
		Array.isArray(value.gainControls) &&
		value.gainControls.every(validGainControl)
	);
}
function validGainControl(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === 'string' &&
		numbers(value, ['min', 'max', 'step', 'default']) &&
		['slider', 'checkbox', 'select'].includes(String(value.type)) &&
		(value.options === undefined ||
			(Array.isArray(value.options) && value.options.every((item: unknown) => typeof item === 'number' && Number.isFinite(item)))) &&
		(value.labels === undefined || (Array.isArray(value.labels) && value.labels.every((item: unknown) => typeof item === 'string')))
	);
}
function validSensorMessage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.type === 'rtl433_event') return numbers(value, ['freq']) && isRecord(value.event);
	if (value.type !== 'rtl433_status' || !isRecord(value.status)) return false;
	const status = value.status;
	return (
		['off', 'loading', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		numbers(status, ['sampleRate', 'samples', 'events']) &&
		(status.protocols === undefined ||
			(Array.isArray(status.protocols) &&
				status.protocols.every(
					(item: unknown) => isRecord(item) && numbers(item, ['id']) && typeof item.name === 'string' && typeof item.disabled === 'boolean',
				)))
	);
}
