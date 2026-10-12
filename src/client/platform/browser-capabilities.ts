import type { CapabilityIssue } from './types';

const missingFeature = (feature: string, message: string, slug: string): CapabilityIssue => ({
	title: `${feature} is unavailable`,
	message,
	href: `https://caniuse.com/${slug}`,
	linkLabel: `See browsers that support ${feature}`,
});

/** Check the API itself: browser names do not guarantee that a feature is enabled. */
export function localUsbIssue(): CapabilityIssue | null {
	if (globalThis.isSecureContext === false)
		return {
			title: 'USB connections need a secure connection',
			message:
				'Open BrowSDR over HTTPS (or localhost for local development) to connect a USB SDR. ' +
				(import.meta.env.DEV ? 'You can still use a remote receiver or Mock SDR.' : 'You can still use a remote receiver.'),
			href: 'https://caniuse.com/webusb',
			linkLabel: 'Learn about WebUSB browser support',
		};
	if (!navigator.usb || typeof navigator.usb.getDevices !== 'function' || typeof navigator.usb.requestDevice !== 'function') {
		return missingFeature(
			'WebUSB',
			'This browser cannot connect to USB SDR devices. Use a browser with WebUSB enabled, such as Chrome or Edge. ' +
				(import.meta.env.DEV ? 'You can still use a remote receiver or Mock SDR.' : 'You can still use a remote receiver.'),
			'webusb',
		);
	}
	return null;
}

export function remoteConnectionIssue(): CapabilityIssue | null {
	return typeof globalThis.RTCPeerConnection === 'function'
		? null
		: missingFeature(
				'WebRTC',
				'This browser cannot connect to or share a remote receiver. Use a browser with WebRTC enabled. ' +
					(import.meta.env.DEV ? 'Local USB receivers and Mock SDR remain available.' : 'Local USB receivers remain available.'),
				'rtcpeerconnection',
			);
}

/** These requirements apply to local, remote, and simulated receivers alike. */
export function coreCapabilityIssues(): CapabilityIssue[] {
	const issues: CapabilityIssue[] = [];
	if (typeof WebAssembly === 'undefined' || typeof WebAssembly.instantiate !== 'function') {
		issues.push(
			missingFeature('WebAssembly', 'BrowSDR needs WebAssembly to process radio signals. Use a browser with WebAssembly enabled.', 'wasm'),
		);
	}
	if (typeof Worker !== 'function')
		issues.push(missingFeature('Web Workers', 'BrowSDR needs Web Workers to process radio signals in the background.', 'webworkers'));
	if (typeof window.AudioContext !== 'function' && typeof window.webkitAudioContext !== 'function') {
		issues.push(missingFeature('Web Audio', 'BrowSDR needs the Web Audio API to play receiver audio.', 'audio-api'));
	}
	let webgl = false;
	try {
		const canvas = document.createElement('canvas');
		const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
		webgl = !!gl;
		gl?.getExtension('WEBGL_lose_context')?.loseContext();
	} catch {
		/* Disabled or unavailable graphics context. */
	}
	if (!webgl)
		issues.push(
			missingFeature(
				'WebGL',
				'BrowSDR needs WebGL for its waterfall display. Enable hardware acceleration in your browser, or use a browser and device with WebGL support.',
				'webgl',
			),
		);
	return issues;
}
