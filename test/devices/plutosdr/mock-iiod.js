/*
WebUSB PlutoSDR stand-in running a small iiod emulator.

Replies are queued as device-side writes and delivered with USB bulk
semantics: 512-byte packets, a transfer ends at a short packet or when the
requested length is filled, and full-packet writes send no zero-length packet.
*/

const PACKET = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function plutoXml({ chip = 'ad9363a', format = 'le:S12/16&gt;&gt;0' } = {}) {
	const rxChannel = (id, index) =>
		`<channel id="${id}" type="input" ><scan-element index="${index}" format="${format}" scale="1.000000" />` +
		`<attribute name="calibscale" filename="in_${id}_calibscale" /></channel>`;
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<!DOCTYPE context [<!ELEMENT context (device | context-attribute)*><!ELEMENT context-attribute EMPTY>' +
		'<!ATTLIST context name CDATA #REQUIRED description CDATA #IMPLIED>]>' +
		'<context name="local" description="Linux (none) 5.15.0 &quot;pluto&quot; &amp; friends" >' +
		'<context-attribute name="hw_model" value="Analog Devices PlutoSDR Rev.C (Z7010-AD9363A)" />' +
		'<context-attribute name="hw_serial" value="104473b04a0600120c00f5ff2b0ade5a57" />' +
		'<context-attribute name="fw_version" value="v0.38" />' +
		`<context-attribute name="ad9361-phy,model" value="${chip}" />` +
		'<device id="iio:device0" name="ad9361-phy" >' +
		'<channel id="altvoltage1" name="TX_LO" type="output" ><attribute name="frequency" filename="out_altvoltage1_TX_LO_frequency" /></channel>' +
		'<channel id="voltage0" type="input" >' +
		['hardwaregain_available', 'hardwaregain', 'gain_control_mode', 'rf_bandwidth', 'sampling_frequency']
			.map((name) => `<attribute name="${name}" filename="in_voltage0_${name}" />`)
			.join('') +
		'</channel>' +
		'<channel id="altvoltage0" name="RX_LO" type="output" ><attribute name="frequency" filename="out_altvoltage0_RX_LO_frequency" />' +
		'<attribute name="frequency_available" filename="out_altvoltage0_RX_LO_frequency_available" /></channel>' +
		'<channel id="out" type="input" ><attribute name="voltage_filter_fir_en" filename="in_out_voltage_filter_fir_en" /></channel>' +
		`<attribute name="filter_fir_config" /><attribute name="ensm_mode" /><debug-attribute name="digital_tune" />` +
		'</device>' +
		'<device id="iio:device1" name="xadc" ><channel id="temp0" type="input" ><attribute name="raw" filename="in_temp0_raw" /></channel></device>' +
		// Listed out of scan order: buffer mask bits must follow the scan index.
		`<device id="iio:device3" name="cf-ad9361-lpc" >${rxChannel('voltage1', 1)}${rxChannel('voltage0', 0)}` +
		'<buffer-attribute name="data_available" /></device>' +
		'</context>'
	);
}

/** Expected int8 output: I ramps up and Q down; the low four bits are noise to drop. */
export function rawSample(k) {
	const step = k % 256;
	return [(step - 128) * 16 + 5, (127 - step) * 16 + 7];
}

function iioEndpoints(pipes) {
	return Array.from({ length: pipes }, (_, i) => [
		{ endpointNumber: i + 1, direction: 'in', type: 'bulk', packetSize: PACKET },
		{ endpointNumber: i + 1, direction: 'out', type: 'bulk', packetSize: PACKET },
	]).flat();
}

function usbConfiguration({ pipes, named }) {
	const iface = (interfaceNumber, alternate) => ({ interfaceNumber, alternate, alternates: [alternate], claimed: false });
	return {
		configurationValue: 1,
		interfaces: [
			iface(0, { interfaceClass: 0xe0, interfaceSubclass: 1, interfaceProtocol: 3, interfaceName: 'RNDIS', endpoints: [] }),
			iface(2, { interfaceClass: 0x08, interfaceSubclass: 6, interfaceProtocol: 0x50, interfaceName: 'Mass Storage', endpoints: [] }),
			iface(3, {
				interfaceClass: 0x02,
				interfaceSubclass: 2,
				interfaceName: 'CDC Abstract Control Model (ACM)',
				endpoints: [{ endpointNumber: 5, direction: 'in', type: 'interrupt', packetSize: 10 }],
			}),
			iface(5, {
				interfaceClass: 0x02,
				interfaceSubclass: 0,
				interfaceProtocol: 0,
				interfaceName: named ? 'IIO' : undefined,
				endpoints: iioEndpoints(pipes),
			}),
		],
	};
}

function join(parts, length) {
	const data = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		data.set(part, offset);
		offset += part.length;
	}
	return new DataView(data.buffer);
}

export function createPluto({
	pipes = 3,
	named = true,
	chunkBytes = Infinity,
	xml = plutoXml(),
	staleLines = [],
	replies = {},
	failReadbuf = [],
	loRange = '[70000000 1 6000000000]',
} = {}) {
	const attributes = new Map([
		['iio:device0 OUTPUT altvoltage0 frequency_available', loRange],
		['iio:device0 OUTPUT altvoltage0 frequency', '2400000000'],
		['iio:device0 INPUT voltage0 hardwaregain_available', '[-1 1 73]'],
		['iio:device0 INPUT voltage0 hardwaregain', '71.000000 dB'],
		['iio:device0 INPUT voltage0 gain_control_mode', 'slow_attack'],
		['iio:device0 INPUT voltage0 sampling_frequency', '520833'],
		['iio:device0 INPUT voltage0 rf_bandwidth', '18000000'],
		['iio:device0 INPUT out voltage_filter_fir_en', '1'],
	]);
	const state = { attributes, controls: [], commands: [], writes: [], opened: null, sampleCounter: 0, readbufs: 0, pipes: new Map() };
	const pipe = (id) => {
		if (!state.pipes.has(id))
			state.pipes.set(id, { open: false, stale: { in: false, out: false }, packets: [], requests: [], pendingWrite: null });
		return state.pipes.get(id);
	};

	// Serve queued IN requests strictly in order, as a host controller does.
	function pump(id) {
		const target = pipe(id);
		while (target.requests.length && target.packets.length) {
			const request = target.requests[0];
			const packet = target.packets[0];
			if (packet.length > request.length - request.received) {
				target.requests.shift();
				request.resolve({ status: 'babble' });
				continue;
			}
			target.packets.shift();
			request.parts.push(packet);
			request.received += packet.length;
			if (packet.length < PACKET || request.received === request.length) {
				target.requests.shift();
				request.resolve({ status: 'ok', data: join(request.parts, request.received) });
			}
		}
	}

	function send(id, data) {
		const bytes = typeof data === 'string' ? encoder.encode(data) : data;
		const target = pipe(id);
		for (let offset = 0; offset < bytes.length; offset += PACKET) target.packets.push(bytes.subarray(offset, offset + PACKET));
		pump(id);
	}

	function readbuf(id, bytes) {
		if (failReadbuf.includes(++state.readbufs)) return send(id, '-110\n');
		for (let sent = 0; sent < bytes;) {
			const length = Math.min(chunkBytes, bytes - sent);
			const data = new Int16Array(length / 2);
			for (let i = 0; i < data.length; i += 2) data.set(rawSample(state.sampleCounter++), i);
			send(id, `${length}\n`);
			if (sent === 0) send(id, '00000003\n');
			send(id, new Uint8Array(data.buffer));
			sent += length;
		}
	}

	function applyWrite(id, key, value) {
		state.writes.push({ key, value });
		const text = decoder.decode(value);
		if (!text.endsWith('\0')) return send(id, '-22\n');
		const parsed = text.slice(0, -1);
		const reply = replies[`WRITE ${key} ${parsed}`];
		if (reply !== undefined) return send(id, `${reply}\n`);
		const fir = attributes.get('iio:device0 INPUT out voltage_filter_fir_en');
		if (key.endsWith('sampling_frequency') && fir === '0' && Number(parsed) < 25e6 / 12) return send(id, '-22\n');
		if (key.endsWith('voltage_filter_fir_en') && Number(attributes.get('iio:device0 INPUT voltage0 sampling_frequency')) < 25e6 / 12)
			return send(id, '-22\n');
		attributes.set(key, parsed);
		send(id, `${value.length}\n`);
	}

	function command(id, line) {
		state.commands.push({ pipe: id, line });
		const words = line.split(' ');
		if (replies[line] !== undefined) return send(id, `${replies[line]}\n`);
		switch (words[0]) {
			case 'VERSION':
				staleLines.splice(0).forEach((stale) => send(id, stale));
				return send(id, '0.25.b6028fd\n');
			case 'PRINT':
				send(id, `${encoder.encode(xml).length}\n`);
				send(id, xml);
				return send(id, '\n');
			case 'READ': {
				const value = attributes.get(words.slice(1).join(' '));
				if (value === undefined) return send(id, '-2\n');
				send(id, `${value.length + 1}\n`);
				return send(id, `${value}\0\n`);
			}
			case 'WRITE':
				pipe(id).pendingWrite = { key: words.slice(1, -1).join(' '), length: Number(words.at(-1)) };
				return;
			case 'OPEN':
				state.opened = { pipe: id, device: words[1], samples: Number(words[2]), mask: words[3] };
				return send(id, '0\n');
			case 'READBUF':
				return readbuf(id, Number(words[2]));
			case 'SET':
			case 'CLOSE':
				return send(id, '0\n');
			default:
				return send(id, '-22\n');
		}
	}

	// Chrome on macOS: a reopened pipe fails transfers until its toggles are reset,
	// and a reset fails transfers in flight on the other pipes.
	function usable(id, direction) {
		const target = pipe(id);
		if (!target.open) throw new Error(`pipe ${id} is not open`);
		if (target.stale[direction]) throw new Error(`pipe ${id} ${direction}: data toggle mismatch`);
		return target;
	}

	function clearHalt(direction, endpoint) {
		state.controls.push({ clearHalt: direction, endpoint });
		pipe(endpoint - 1).stale[direction] = false;
		for (const [id, other] of state.pipes) {
			if (id === endpoint - 1) continue;
			other.requests.splice(0).forEach((request) => request.reject(new Error(`pipe ${id}: transfer aborted by an endpoint reset`)));
		}
	}

	async function transferIn(endpoint, length) {
		const target = usable(endpoint - 1, 'in');
		return new Promise((resolve, reject) => {
			target.requests.push({ length, received: 0, parts: [], resolve, reject });
			pump(endpoint - 1);
		});
	}

	async function transferOut(endpoint, data) {
		const id = endpoint - 1;
		const target = usable(id, 'out');
		const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
		if (target.pendingWrite) {
			const { key, length } = target.pendingWrite;
			target.pendingWrite = null;
			if (bytes.length !== length) throw new Error(`WRITE ${key}: expected ${length} bytes, got ${bytes.length}`);
			applyWrite(id, key, bytes.slice());
		} else {
			const text = decoder.decode(bytes);
			if (!text.endsWith('\r\n') || text.indexOf('\r\n') !== text.length - 2)
				throw new Error(`one command per transfer: ${JSON.stringify(text)}`);
			command(id, text.slice(0, -2));
		}
		return { status: 'ok', bytesWritten: bytes.length };
	}

	const usb = {
		configuration: usbConfiguration({ pipes, named }),
		serialNumber: '104473b04a0600120c00f5ff2b0ade5a57',
		manufacturerName: 'Analog Devices Inc.',
		productName: 'PlutoSDR (ADALM-PLUTO)',
		vendorId: 0x0456,
		productId: 0xb673,
		open: async () => {},
		close: async () => {},
		selectConfiguration: async () => {
			throw new Error('configuration already active');
		},
		claimInterface: async (number) => state.controls.push({ claim: number }),
		releaseInterface: async (number) => state.controls.push({ release: number }),
		clearHalt: async (direction, endpoint) => clearHalt(direction, endpoint),
		controlTransferOut: async (setup) => {
			state.controls.push(setup);
			if (setup.request === 0) state.pipes.forEach((p) => (p.open = false));
			if (setup.request === 1) Object.assign(pipe(setup.value), { open: true, stale: { in: true, out: true } });
			if (setup.request === 2) pipe(setup.value).open = false;
			return { status: 'ok', bytesWritten: 0 };
		},
		transferOut,
		transferIn,
	};
	return { usb, state, unread: (id) => pipe(id).packets.length, pendingReads: (id) => pipe(id).requests.length };
}
