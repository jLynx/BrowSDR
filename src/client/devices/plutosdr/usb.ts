import type { IiodPipeEndpoints, IiodUsbInterface } from './types';

/*
libiio USB transport discovery and pipe control.

iiod exposes one interface named "IIO" with interleaved bulk IN/OUT endpoint
couples. Vendor requests on that interface reset, open and close the
per-couple parsers; libiio reserves couple 0 for context commands.
*/

const IIO_INTERFACE_NAME = 'IIO';
const USB_CLASS_COMM = 0x02;
const IIO_USD_CMD_RESET_PIPES = 0;
const IIO_USD_CMD_OPEN_PIPE = 1;
const IIO_USD_CMD_CLOSE_PIPE = 2;

function pairEndpoints(endpoints: USBEndpoint[]): IiodPipeEndpoints[] {
	if (endpoints.length < 2 || endpoints.length % 2 || endpoints.some((endpoint) => endpoint.type !== 'bulk')) return [];
	const pipes: IiodPipeEndpoints[] = [];
	for (let i = 0; i < endpoints.length; i += 2) {
		const couple = endpoints.slice(i, i + 2);
		const input = couple.find((endpoint) => endpoint.direction === 'in');
		const output = couple.find((endpoint) => endpoint.direction === 'out');
		if (!input || !output) return [];
		pipes.push({
			pipeId: i / 2,
			inEndpoint: input.endpointNumber,
			outEndpoint: output.endpointNumber,
			packetSize: input.packetSize || 512,
		});
	}
	return pipes;
}

/** Find the iiod interface by name, falling back to its descriptor shape when strings are unavailable. */
export function findIiodInterface(device: USBDevice): IiodUsbInterface | null {
	const interfaces = device.configuration?.interfaces ?? [];
	const candidates = interfaces
		.map((usbInterface) => ({ usbInterface, alternate: usbInterface.alternates[0] ?? usbInterface.alternate }))
		.filter(({ alternate }) => alternate);
	const named = candidates.filter(({ alternate }) => alternate.interfaceName === IIO_INTERFACE_NAME);
	const shaped = candidates.filter(({ alternate }) => alternate.interfaceClass === USB_CLASS_COMM && alternate.interfaceSubclass === 0);
	for (const { usbInterface, alternate } of [...named, ...shaped]) {
		const pipes = pairEndpoints(alternate.endpoints);
		if (pipes.length) return { interfaceNumber: usbInterface.interfaceNumber, pipes };
	}
	return null;
}

async function pipeRequest(device: USBDevice, usbInterface: IiodUsbInterface, request: number, pipeId: number): Promise<void> {
	const result = await device.controlTransferOut({
		requestType: 'vendor',
		recipient: 'interface',
		request,
		value: pipeId,
		index: usbInterface.interfaceNumber,
	});
	if (result.status !== 'ok') throw new Error(`PlutoSDR: IIO pipe request ${request} failed (${result.status})`);
}

export function resetPipes(device: USBDevice, usbInterface: IiodUsbInterface): Promise<void> {
	return pipeRequest(device, usbInterface, IIO_USD_CMD_RESET_PIPES, 0);
}

/**
 * OPEN_PIPE recreates the pipe's endpoints on the device at DATA0 while the host
 * keeps its old data toggles, which Chrome on macOS reports as transfer errors.
 * Clearing the halt resets both ends. Only do this before streaming starts: on
 * macOS it also fails transfers in flight on other pipes.
 */
export async function openPipe(device: USBDevice, usbInterface: IiodUsbInterface, pipe: IiodPipeEndpoints): Promise<void> {
	await pipeRequest(device, usbInterface, IIO_USD_CMD_OPEN_PIPE, pipe.pipeId);
	await device.clearHalt('in', pipe.inEndpoint).catch(() => {});
	await device.clearHalt('out', pipe.outEndpoint).catch(() => {});
}

export function closePipe(device: USBDevice, usbInterface: IiodUsbInterface, pipeId: number): Promise<void> {
	return pipeRequest(device, usbInterface, IIO_USD_CMD_CLOSE_PIPE, pipeId);
}
