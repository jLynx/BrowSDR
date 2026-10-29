import { isAprsFrame, latin1, printable, readable } from './ax25';
import { decodeNmea, decodePosition } from './position';
import { decodeMicE } from './mic-e';
import { decodeWeather } from './weather';
import type { AprsPacket, AprsReport, AprsTelemetryDefinition, AprsTextMessage, Ax25Frame } from './types';

const TIMESTAMP = /^\d{6}[zh/]$/;

function position(text: string, messaging: boolean): AprsReport | undefined {
	const decoded = decodePosition(text);
	if (!decoded) return;
	return { kind: decoded.weather ? 'weather' : 'position', messaging, ...decoded };
}

function timestamped(text: string, messaging: boolean): AprsReport | undefined {
	if (!TIMESTAMP.test(text.slice(0, 7))) return;
	const report = position(text.slice(7), messaging);
	return report && { ...report, timestamp: text.slice(0, 7) };
}

function object(info: string): AprsReport | undefined {
	const match = /^;([ -~]{9})([*_])(\d{6}[zh/])/.exec(info);
	const name = match?.[1].trimEnd();
	const report = name && decodePosition(info.slice(18));
	if (!match || !name || !report) return;
	return { kind: 'object', name, killed: match[2] === '_', timestamp: match[3], ...report };
}

function item(info: string): AprsReport | undefined {
	const match = /^\)([ -~]{3,9}?)([!_])/.exec(info);
	const report = match && !/[!_]/.test(match[1]) && decodePosition(info.slice(match[0].length));
	if (!match || !report) return;
	return { kind: 'item', name: match[1], killed: match[2] === '_', ...report };
}

function message(info: string): AprsReport | undefined {
	const match = /^:([ -~]{9}):([\s\S]*)$/.exec(info);
	if (!match) return;
	const addressee = match[1].trim();
	const body = match[2];
	let content: AprsTextMessage;
	const reply = /^(ack|rej)([A-Za-z0-9]{1,5})(?:\}[A-Za-z0-9]{0,5})?\s*$/.exec(body);
	if (/^(PARM|UNIT|EQNS|BITS)\./.test(body)) content = { kind: 'telemetry-definition', addressee, text: readable(body) };
	else if (reply) content = { kind: reply[1] === 'ack' ? 'ack' : 'reject', addressee, text: '', id: reply[2] };
	else {
		// `{id` requests an acknowledgement; APRS 1.1 reply-acks append `}ack-id`.
		const brace = body.lastIndexOf('{');
		const id = brace < 0 ? undefined : /^([A-Za-z0-9]{1,5})(?:\}[A-Za-z0-9]{0,5})?\s*$/.exec(body.slice(brace + 1))?.[1];
		const kind = /^(BLN|NWS-|SKY|CWA|BOM)/.test(addressee) ? 'bulletin' : 'message';
		content = { kind, addressee, text: readable(id ? body.slice(0, brace) : body), ...(id ? { id } : {}) };
	}
	return { kind: 'message', message: content };
}

function status(info: string): AprsReport {
	const timestamp = /^\d{6}z/.test(info.slice(1)) ? info.slice(1, 8) : undefined;
	return { kind: 'status', status: readable(info.slice(timestamp ? 8 : 1)), ...(timestamp ? { timestamp } : {}) };
}

function telemetry(info: string): AprsReport | undefined {
	const match = /^T#([^,]{0,5}),(.*)$/s.exec(info);
	if (!match) return;
	const parts = match[2].split(',');
	const analog: number[] = [];
	for (const part of parts.slice(0, 5)) {
		if (!/^\s*-?\d+(\.\d+)?\s*$/.test(part)) break;
		analog.push(Number(part));
	}
	const tail = parts.slice(analog.length).join(',');
	const digital = analog.length === 5 ? /^[01]{1,8}/.exec(tail)?.[0] : undefined;
	const comment = readable(digital ? tail.slice(digital.length) : '');
	return {
		kind: 'telemetry',
		telemetry: { sequence: readable(match[1]), analog, ...(digital ? { digital } : {}) },
		...(comment ? { comment } : {}),
	};
}

function positionlessWeather(info: string): AprsReport | undefined {
	if (!/^_\d{8}/.test(info)) return;
	const { weather, rest } = decodeWeather(info.slice(9), {}, true);
	const comment = readable(rest);
	return { kind: 'weather', timestamp: info.slice(1, 9), weather, ...(comment ? { comment } : {}) };
}

function nmea(info: string): AprsReport | undefined {
	const decoded = decodeNmea(info);
	return decoded && { kind: 'position', ...decoded };
}

function micE(info: string, destination: string): AprsReport | undefined {
	const decoded = decodeMicE(destination, info);
	return decoded && { kind: 'position', ...decoded };
}

// APRS 1.0.1 data type identifiers.
const DECODERS: Record<string, (info: string, destination: string) => AprsReport | undefined> = {
	'!': (info) => position(info.slice(1), false),
	'=': (info) => position(info.slice(1), true),
	'/': (info) => timestamped(info.slice(1), false),
	'@': (info) => timestamped(info.slice(1), true),
	';': object,
	')': item,
	':': message,
	'>': status,
	T: telemetry,
	_: positionlessWeather,
	$: nmea,
	'`': micE,
	"'": micE,
	'\x1c': micE,
	'\x1d': micE,
	'<': (info) => ({ kind: 'capabilities', comment: readable(info.slice(1)) }),
	'?': (info) => ({ kind: 'query', comment: readable(info.slice(1)) }),
};

export function decodeInfo(info: string, destination: string): AprsReport {
	const decoded = DECODERS[info[0]]?.(info, destination);
	if (decoded) return decoded;
	// Some trackers prefix a position with text: `!` may appear anywhere in the first 40 characters.
	const bang = info.indexOf('!');
	const fallback = bang > 0 && bang < 40 ? position(info.slice(bang + 1), false) : undefined;
	if (fallback) return fallback;
	const comment = readable(info);
	return { kind: 'other', ...(comment ? { comment } : {}) };
}

/** Header and information field of a third-party packet: `SOURCE>DEST,PATH:info`. */
function thirdParty(text: string): { source: string; destination: string; path: string[]; info: string } | undefined {
	const match = /^([A-Z0-9]{1,6}(?:-[0-9A-Z]{1,2})?)>([A-Z0-9]{1,6}(?:-\d{1,2})?)((?:,[A-Za-z0-9-]{1,9}\*?){0,8}):([\s\S]*)$/.exec(text);
	if (!match || match[4].startsWith('}')) return;
	return { source: match[1], destination: match[2], path: match[3] ? match[3].slice(1).split(',') : [], info: match[4] };
}

/**
 * Identity of a report for repeat detection: originating station, destination call and information field.
 * Third-party copies are unwrapped. Routing paths, the destination SSID (which also routes) and the trailing
 * spaces or line ends that gateways may strip are ignored. Mic-E keeps its latitude in the destination call.
 */
export function repeatKey(frame: Ax25Frame): string {
	const raw = latin1(frame.info);
	const inner = isAprsFrame(frame) && raw.startsWith('}') ? thirdParty(raw.slice(1)) : undefined;
	const { source, destination, info } = inner ?? { source: frame.source, destination: frame.destination, info: raw };
	return `${source}>${destination.split('-')[0]}:${info.replace(/[\r\n ]+$/, '')}`;
}

export function decodePacket(frame: Ax25Frame): Omit<AprsPacket, 'id' | 'receivedAt'> {
	const raw = latin1(frame.info);
	const header = { source: frame.source, destination: frame.destination, path: frame.path, info: printable(raw) };
	if (!isAprsFrame(frame)) return { ...header, kind: 'ax25' };
	const inner = raw.startsWith('}') ? thirdParty(raw.slice(1)) : undefined;
	if (!inner) return { ...header, ...decodeInfo(raw, frame.destination) };
	return {
		...header,
		source: inner.source,
		destination: inner.destination,
		path: inner.path,
		relay: frame.source,
		...decodeInfo(inner.info, inner.destination),
	};
}

/** PARM., UNIT., EQNS. and BITS. telemetry definition messages, addressed by a station to itself. */
export function telemetryDefinition(text: string): AprsTelemetryDefinition | undefined {
	const match = /^(PARM|UNIT|EQNS|BITS)\.(.*)$/.exec(text);
	if (!match) return;
	const values = match[2].split(',').map((value) => value.trim());
	if (match[1] === 'PARM') return { names: values.slice(0, 13) };
	if (match[1] === 'UNIT') return { units: values.slice(0, 13) };
	if (match[1] === 'BITS') {
		const bits = /^[01]{8}$/.exec(values[0])?.[0];
		const project = match[2].slice(match[2].indexOf(',') + 1).trim();
		return { ...(bits ? { bits } : {}), ...(match[2].includes(',') && project ? { project } : {}) };
	}
	const coefficients = values.slice(0, 15).map(Number);
	if (coefficients.length < 3 || coefficients.some((value) => !Number.isFinite(value))) return;
	const equations: number[][] = [];
	for (let index = 0; index + 2 < coefficients.length; index += 3) equations.push(coefficients.slice(index, index + 3));
	return { equations };
}
