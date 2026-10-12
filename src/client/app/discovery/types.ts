import type { DiscoverySignal } from '@/worker/discovery/types';

export interface DiscoveryBridge {
	submit(data: Float32Array): void;
	selected(): DiscoverySignal | undefined;
}
