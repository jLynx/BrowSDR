/// <reference types="vite/client" />

// WebUSB API types
interface USBDeviceFilter {
	vendorId?: number;
	productId?: number;
	classCode?: number;
	subclassCode?: number;
	protocolCode?: number;
	serialNumber?: string;
}

interface USBDeviceRequestOptions {
	filters: USBDeviceFilter[];
}

interface USBConfiguration {
	configurationValue: number;
	configurationName: string | null;
	interfaces: USBInterface[];
}

interface USBInterface {
	interfaceNumber: number;
	alternate: USBAlternateInterface;
	alternates: USBAlternateInterface[];
	claimed: boolean;
}

interface USBAlternateInterface {
	alternateSetting: number;
	interfaceClass: number;
	interfaceSubclass: number;
	interfaceProtocol: number;
	interfaceName: string | null;
	endpoints: USBEndpoint[];
}

interface USBEndpoint {
	endpointNumber: number;
	direction: 'in' | 'out';
	type: 'bulk' | 'interrupt' | 'isochronous';
	packetSize: number;
}

interface USBDevice {
	manufacturerName?: string;
	open(): Promise<void>;
	close(): Promise<void>;
	selectConfiguration(configurationValue: number): Promise<void>;
	claimInterface(interfaceNumber: number): Promise<void>;
	releaseInterface(interfaceNumber: number): Promise<void>;
	controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>;
	controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>;
	transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
	transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
	configuration: USBConfiguration | null;
	vendorId: number;
	productId: number;
	productName: string;
	serialNumber: string;
	deviceVersionMajor: number;
	deviceVersionMinor: number;
	deviceVersionSubminor: number;
}

interface USBControlTransferParameters {
	requestType: 'vendor' | 'standard' | 'class';
	recipient: 'device' | 'interface' | 'endpoint' | 'other';
	request: number;
	value: number;
	index: number;
}

interface USBInTransferResult {
	status: 'ok' | 'stall' | 'babble';
	data: DataView;
}

interface USBOutTransferResult {
	status: 'ok' | 'stall';
	bytesWritten: number;
}

interface USB extends EventTarget {
	getDevices(): Promise<USBDevice[]>;
	requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
}

interface USBConnectionEvent extends Event {
	device: USBDevice;
}
interface Window {
	webkitAudioContext?: typeof AudioContext;
}
interface Navigator {
	usb: USB;
}

// Cloudflare request-lifetime context.
interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}
