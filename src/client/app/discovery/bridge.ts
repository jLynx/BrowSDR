import type { AppInstance } from '@/app/core/receiver.types';
import type { DiscoveryBridge } from './types';

const bridges = new WeakMap<AppInstance, DiscoveryBridge>();

export function registerDiscovery(receiver: AppInstance, bridge: DiscoveryBridge): () => void {
	bridges.set(receiver, bridge);
	return () => bridges.delete(receiver);
}

export function submitDiscovery(receiver: AppInstance, data: Float32Array): void {
	bridges.get(receiver)?.submit(data);
}

export function drawDiscovery(receiver: AppInstance, ctx: CanvasRenderingContext2D, width: number, height: number): void {
	const signal = bridges.get(receiver)?.selected();
	if (!signal || !receiver.discovery.panelOpen) return;
	const span = receiver.radio.sampleRate / receiver.view.zoomScale;
	const leftHz = receiver.radio.centerFreq * 1e6 - receiver.radio.sampleRate / 2 + receiver.view.zoomOffset * receiver.radio.sampleRate;
	const x = ((signal.frequencyHz - leftHz) / span) * width;
	const band = Math.max(2, (signal.widthHz / span) * width);
	ctx.save();
	const active = receiver.running && receiver.discovery.enabled && signal.active && Date.now() - signal.lastSeen < 1500;
	if (active) {
		ctx.fillStyle = 'rgba(0, 210, 210, 0.16)';
		ctx.fillRect(x - band / 2, 0, band, height);
	} else ctx.setLineDash([4, 4]);
	ctx.strokeStyle = '#00d2d2';
	ctx.strokeRect(x - band / 2, 0, band, height);
	ctx.restore();
}
