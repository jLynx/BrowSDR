import { decodeAcars } from './messages';
import type { AcarsRecord } from './types';

export class AcarsLog {
	frames = 0;
	private messages: AcarsRecord[] = [];
	process(frame: Uint8Array, now = Date.now()): void {
		const report = decodeAcars(frame);
		if (!report) return;
		this.messages.push({ ...report, id: ++this.frames, receivedAt: now });
		if (this.messages.length > 200) this.messages.shift();
	}
	snapshot(): AcarsRecord[] {
		return this.messages.map((item) => ({ ...item }));
	}
}
