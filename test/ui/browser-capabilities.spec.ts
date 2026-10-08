import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { coreCapabilityIssues, localUsbIssue, remoteConnectionIssue } from '../../src/client/platform/browser-capabilities';
import { UiNotice } from '../../src/client/ui';
import { createWorkspace } from '../../src/client/app/workspace/workspace';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('browser capability checks', () => {
	it('distinguishes HTTPS requirements from missing WebUSB', () => {
		vi.stubGlobal('isSecureContext', false);
		expect(localUsbIssue()?.title).toContain('secure connection');
		vi.stubGlobal('isSecureContext', true);
		expect(localUsbIssue()?.title).toBe('WebUSB is unavailable');
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn(), requestDevice: vi.fn() } });
		expect(localUsbIssue()).toBeNull();
	});
	it('allows core startup without optional APIs and accepts prefixed Web Audio', () => {
		vi.stubGlobal('Worker', vi.fn());
		vi.stubGlobal('AudioContext', undefined);
		vi.stubGlobal('webkitAudioContext', vi.fn());
		vi.stubGlobal('SharedArrayBuffer', undefined);
		vi.stubGlobal('navigator', {});
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			getExtension: () => null,
		} as unknown as CanvasRenderingContext2D);
		expect(coreCapabilityIssues()).toEqual([]);
	});
	it('reports missing core features before startup', () => {
		vi.stubGlobal('Worker', undefined);
		vi.stubGlobal('WebAssembly', undefined);
		vi.stubGlobal('AudioContext', undefined);
		vi.stubGlobal('webkitAudioContext', undefined);
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
		expect(coreCapabilityIssues().map((issue) => issue.title)).toEqual([
			'WebAssembly is unavailable',
			'Web Workers is unavailable',
			'Web Audio is unavailable',
			'WebGL is unavailable',
		]);
	});
	it('checks remote requirements independently of WebUSB', () => {
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('RTCPeerConnection', vi.fn());
		expect(remoteConnectionIssue()).toBeNull();
		vi.stubGlobal('RTCPeerConnection', undefined);
		expect(remoteConnectionIssue()?.href).toBe('https://caniuse.com/rtcpeerconnection');
	});
	it('stops a share-link connection before tearing down local receivers if WebRTC is missing', async () => {
		vi.stubGlobal('RTCPeerConnection', undefined);
		const options = createWorkspace({});
		const workspace = { ...options.data(), stopSharing: vi.fn(), removeReceiver: vi.fn() };
		await options.methods.connectRemote.call(
			workspace as unknown as Parameters<typeof options.methods.connectRemote.call>[0],
			'share-code',
		);
		expect(workspace.remoteCapabilityIssue?.href).toBe('https://caniuse.com/rtcpeerconnection');
		expect(workspace.mode).toBe('none');
		expect(workspace.stopSharing).not.toHaveBeenCalled();
	});
	it('renders accessible guidance and a safe external support link', () => {
		const wrapper = mount(UiNotice, {
			props: {
				title: 'WebUSB is unavailable',
				message: 'Try a remote receiver.',
				href: 'https://caniuse.com/webusb',
				linkLabel: 'Supported browsers',
			},
		});
		expect(wrapper.attributes('role')).toBe('status');
		expect(wrapper.get('a').attributes()).toMatchObject({
			href: 'https://caniuse.com/webusb',
			target: '_blank',
			rel: 'noopener noreferrer',
		});
		wrapper.unmount();
	});
});
