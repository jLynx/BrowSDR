import { SignalTracker } from './tracker';
import type { DiscoveryFrame } from './types';

const tracker = new SignalTracker();
self.onmessage = (event: MessageEvent<DiscoveryFrame>) => {
	self.postMessage(tracker.process(event.data));
};
