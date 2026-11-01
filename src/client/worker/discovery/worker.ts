import { SignalTracker } from './tracker';
import { analyseDiscoveryFrame } from './analysis';
import type { DiscoveryFrame } from './types';

const tracker = new SignalTracker();
self.onmessage = (event: MessageEvent<DiscoveryFrame>) => {
	self.postMessage(analyseDiscoveryFrame(event.data, tracker));
};
