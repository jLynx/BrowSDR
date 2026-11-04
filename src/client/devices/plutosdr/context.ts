import type { IioChannel, IioContext, IioDevice, IioSampleFormat } from './types';

/*
IIO context XML parsing for the PlutoSDR WebUSB driver.

The driver runs in a worker, where DOMParser is unavailable. libiio's XML is
machine-written and flat, so a tag scanner is enough: it skips the DTD,
tracks the current device/channel and keeps only what the driver needs.
*/

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
		}
		return ENTITIES[body] ?? entity;
	});
}

function parseAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of source.matchAll(ATTRIBUTE)) attributes[match[1]] = decodeEntities(match[2] ?? match[3] ?? '');
	return attributes;
}

/** Match libiio's reorder_channels(): scan elements first by index (then shift), others after. */
function assignMaskBits(device: IioDevice, shifts: Map<IioChannel, number>): void {
	const ordered = device.channels.map((channel, position) => ({ channel, position }));
	ordered.sort((a, b) => {
		const ai = a.channel.scanIndex ?? -1;
		const bi = b.channel.scanIndex ?? -1;
		if (ai < 0 || bi < 0) return ai < 0 && bi < 0 ? a.position - b.position : ai < 0 ? 1 : -1;
		if (ai !== bi) return ai - bi;
		return (shifts.get(a.channel) ?? 0) - (shifts.get(b.channel) ?? 0) || a.position - b.position;
	});
	ordered.forEach(({ channel }, bit) => (channel.maskBit = bit));
}

class ContextBuilder {
	readonly context: IioContext = { attributes: {}, devices: [] };
	private device: IioDevice | null = null;
	private channel: IioChannel | null = null;
	private readonly shifts = new Map<IioChannel, number>();

	open(tag: string, attributes: Record<string, string>): void {
		const { context, device, channel } = this;
		switch (tag) {
			case 'context':
				context.name = attributes.name;
				context.description = attributes.description;
				break;
			case 'context-attribute':
				if (attributes.name) context.attributes[attributes.name] = attributes.value ?? '';
				break;
			case 'device':
				this.device = { id: attributes.id, name: attributes.name, label: attributes.label, channels: [], attributes: [] };
				context.devices.push(this.device);
				break;
			case 'channel':
				if (!device) break;
				this.channel = {
					id: attributes.id,
					name: attributes.name,
					output: attributes.type === 'output',
					scanIndex: null,
					attributes: [],
					maskBit: -1,
				};
				device.channels.push(this.channel);
				break;
			case 'scan-element':
				if (!channel) break;
				channel.scanIndex = Number(attributes.index);
				channel.format = attributes.format;
				this.shifts.set(channel, parseSampleFormat(attributes.format)?.shift ?? 0);
				break;
			case 'attribute':
				(channel ?? device)?.attributes.push(attributes.name);
				break;
		}
	}

	close(tag: string): void {
		if (tag === 'channel') this.channel = null;
		if (tag === 'device' && this.device) {
			assignMaskBits(this.device, this.shifts);
			this.device = null;
		}
	}
}

export function parseIioContext(xml: string): IioContext {
	const builder = new ContextBuilder();
	for (const [, closing, tag, rawAttributes, selfClosing] of xml.matchAll(TAG)) {
		if (!closing) builder.open(tag, parseAttributes(rawAttributes));
		if (closing || selfClosing) builder.close(tag);
	}
	return builder.context;
}

/** Parse formats such as `le:S12/16>>0` (endianness, sign, bits/storage bits, shift). */
export function parseSampleFormat(format: string | undefined): IioSampleFormat | null {
	const match = /^([lb])e:([sSuU])(\d+)\/(\d+)(?:X\d+)?>>(\d+)$/.exec(format ?? '');
	if (!match) return null;
	return {
		littleEndian: match[1] === 'l',
		signed: match[2] === 's' || match[2] === 'S',
		bits: Number(match[3]),
		storageBits: Number(match[4]),
		shift: Number(match[5]),
	};
}

export function findDevice(context: IioContext, name: string): IioDevice | undefined {
	return context.devices.find((device) => device.name === name || device.id === name);
}

export function findChannel(device: IioDevice, id: string, output: boolean): IioChannel | undefined {
	return device.channels.find((channel) => channel.output === output && (channel.id === id || channel.name === id));
}

/** Hex buffer mask as `iiod OPEN` expects: 8 digits per 32-bit word, most significant word first. */
export function bufferMask(device: IioDevice, channels: IioChannel[]): string {
	const words = new Uint32Array(Math.max(1, Math.ceil(device.channels.length / 32)));
	for (const channel of channels) words[channel.maskBit >> 5] |= 1 << (channel.maskBit & 31);
	return Array.from(words)
		.reverse()
		.map((word) => word.toString(16).padStart(8, '0'))
		.join('');
}
