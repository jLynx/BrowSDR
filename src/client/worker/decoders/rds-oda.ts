// RDS ODA (Open Data Application) decoders: RT+, eRT+, eRT, TMC.
// Extracted from RDSDecoder to keep that class within the max-lines limit.

import type { RDSMessage } from './types';
import { RTPLUS_TYPES } from './rds-tables';

export class RDSOdaDecoder {
	// Registered ODA group keys
	rtPlusGroup = -1;
	eRTPlusGroup = -1;
	eRTPlusCb = 0;
	eRTGroup = -1;
	tmcGroup = -1;

	// RT+ state
	private rtPlusText1 = '';
	private rtPlusText2 = '';
	private rtPlusTag1 = 0;
	private rtPlusTag2 = 0;
	private rtPlusToggle = -1;
	private rtPlusRunning = -1;

	// eRT+ state (independent from RT+)
	private eRTPlusText1 = '';
	private eRTPlusText2 = '';
	private eRTPlusTag1 = 0;
	private eRTPlusTag2 = 0;
	private eRTPlusToggle = -1;
	private eRTPlusRunning = -1;

	// eRT state
	private eRTBytes: Uint8Array = new Uint8Array(128);
	private eRTFilled: boolean[] = new Array<boolean>(128).fill(false);
	private eRTQuality: number[] = new Array<number>(128).fill(0);
	private lastERT = '';

	// TMC state
	private tmcContinuity = 0;
	private tmcParts: Array<{ y: number; z: number } | null> = [null, null, null, null, null];

	constructor(
		private readonly getBlocks: () => number[],
		private readonly getBlockValid: () => boolean[],
		private readonly getBlockQuality: (idx: number) => number,
		private readonly getLastRt: () => string,
		private readonly cb: (msg: RDSMessage) => void,
	) {}

	reset(): void {
		this.rtPlusGroup = -1;
		this.rtPlusText1 = '';
		this.rtPlusText2 = '';
		this.rtPlusTag1 = 0;
		this.rtPlusTag2 = 0;
		this.rtPlusToggle = -1;
		this.rtPlusRunning = -1;
		this.eRTPlusGroup = -1;
		this.eRTPlusCb = 0;
		this.eRTPlusText1 = '';
		this.eRTPlusText2 = '';
		this.eRTPlusTag1 = 0;
		this.eRTPlusTag2 = 0;
		this.eRTPlusToggle = -1;
		this.eRTPlusRunning = -1;
		this.eRTGroup = -1;
		this.eRTBytes.fill(0);
		this.eRTFilled.fill(false);
		this.eRTQuality.fill(0);
		this.lastERT = '';
		this.tmcGroup = -1;
		this.tmcContinuity = 0;
		this.tmcParts = [null, null, null, null, null];
	}

	clearRtPlus(): void {
		if (this.rtPlusText1 || this.rtPlusText2) {
			this.rtPlusText1 = '';
			this.rtPlusText2 = '';
			// Send empty strings (not undefined) so the app-side guard
			// (msg.rtPlusItem1 !== undefined) passes and the station card clears.
			this.cb({
				rtPlusRunning: false,
				rtPlusToggle: this.rtPlusToggle >= 0 ? this.rtPlusToggle : 0,
				rtPlusItem1: '',
				rtPlusItem1Tag: 0,
				rtPlusItem1Name: '',
				rtPlusItem2: '',
				rtPlusItem2Tag: 0,
				rtPlusItem2Name: '',
			});
		}
	}

	dispatch(key: number, groupNum: number, version: number, blockB: number, bv: boolean[]): void {
		const blocks = this.getBlocks();
		const bvFull = this.getBlockValid();
		if (bvFull[2] && bvFull[3]) this.cb({ odaData: { group: groupNum, version, b: blockB & 0x1f, c: blocks[2], d: blocks[3] } });
		if (key === this.rtPlusGroup && bv[1] && bv[2] && bv[3]) this.decodeRtPlus(blockB, blocks[2], blocks[3]);
		if (key === this.eRTPlusGroup && bv[1] && bv[2] && bv[3]) this.decodeERtPlus(blockB, blocks[2], blocks[3]);
		if (key === this.eRTGroup && bv[1]) this.decodeERT(blockB, bv);
		if (key === this.tmcGroup && bv[1]) this.decodeTMC(blockB, bv);
	}

	private decodeERT(blockB: number, bv: boolean[]): void {
		const blocks = this.getBlocks();
		// eRT uses a 5-bit segment address (bits [4:0] of block B), giving 32
		// segments (0-31) of 4 bytes each = 128 bytes maximum. There is no
		// text A/B bit here: bits [9:5] belong to PTY.
		const seg = blockB & 0x1f;
		const base = seg * 4;
		if (this.ertSegmentChanged(base, bv)) {
			// A changed, equally reliable segment starts a new text assembly.
			// Retain the last complete text until its replacement is complete.
			this.eRTBytes.fill(0);
			this.eRTFilled.fill(false);
			this.eRTQuality.fill(0);
		}
		const wb = (pos: number, val: number, q: number) => {
			if (!this.eRTFilled[pos]) {
				this.eRTBytes[pos] = val;
				this.eRTFilled[pos] = true;
				this.eRTQuality[pos] = q;
			} else if (q < this.eRTQuality[pos]) {
				this.eRTBytes[pos] = val;
				this.eRTQuality[pos] = q;
			}
		};
		if (bv[2]) {
			const c = blocks[2];
			const q = this.getBlockQuality(2);
			wb(base, (c >> 8) & 0xff, q);
			wb(base + 1, c & 0xff, q);
		} else {
			wb(base, 0x20, 2);
			wb(base + 1, 0x20, 2);
		}
		if (bv[3]) {
			const d = blocks[3];
			const q = this.getBlockQuality(3);
			wb(base + 2, (d >> 8) & 0xff, q);
			wb(base + 3, d & 0xff, q);
		} else {
			wb(base + 2, 0x20, 2);
			wb(base + 3, 0x20, 2);
		}
		let seqLen = 0;
		while (seqLen < 128 && this.eRTFilled[seqLen]) {
			if (this.eRTBytes[seqLen] === 0x0d) {
				seqLen++;
				break;
			}
			seqLen++;
		}
		if (seqLen === 0) return;
		const hasCr = this.eRTBytes[seqLen - 1] === 0x0d;
		const isComplete = hasCr || seqLen >= 128;
		const rawLen = hasCr ? seqLen - 1 : seqLen;
		const { chars, cpQuality } = this._ertDecodeUtf8(rawLen);
		while (chars.length > 0 && chars[chars.length - 1] === ' ') {
			chars.pop();
			cpQuality.pop();
		}
		const text = chars.join('');
		if (text.length < 1) return;
		if (isComplete) {
			if (text !== this.lastERT) {
				this.lastERT = text;
				this.cb({ eRT: text, eRTCharStatus: cpQuality });
			}
		} else {
			this.cb({ eRTPartial: text, eRTCharStatus: cpQuality });
		}
	}

	private ertSegmentChanged(base: number, bv: boolean[]): boolean {
		const blocks = this.getBlocks();
		for (const block of [2, 3]) {
			if (!bv[block]) continue;
			const quality = this.getBlockQuality(block);
			for (let byte = 0; byte < 2; byte++) {
				const pos = base + (block - 2) * 2 + byte;
				const value = (blocks[block] >> (byte === 0 ? 8 : 0)) & 0xff;
				if (this.eRTFilled[pos] && this.eRTQuality[pos] < 2 && quality <= this.eRTQuality[pos] && value !== this.eRTBytes[pos]) return true;
			}
		}
		return false;
	}

	private _ertDecodeUtf8(rawLen: number): { chars: string[]; cpQuality: number[] } {
		const chars: string[] = [];
		const cpQuality: number[] = [];
		let i = 0;
		while (i < rawLen) {
			const b0 = this.eRTBytes[i];
			let seqBytes: number;
			if ((b0 & 0x80) === 0x00) seqBytes = 1;
			else if ((b0 & 0xe0) === 0xc0) seqBytes = 2;
			else if ((b0 & 0xf0) === 0xe0) seqBytes = 3;
			else if ((b0 & 0xf8) === 0xf0) seqBytes = 4;
			else {
				chars.push('?');
				cpQuality.push(this.eRTQuality[i]);
				i++;
				continue;
			}
			if (i + seqBytes > rawLen) {
				chars.push('?');
				cpQuality.push(2);
				i++;
				continue;
			}
			let valid = true;
			for (let j = 1; j < seqBytes; j++)
				if ((this.eRTBytes[i + j] & 0xc0) !== 0x80) {
					valid = false;
					break;
				}
			if (!valid) {
				chars.push('?');
				cpQuality.push(this.eRTQuality[i]);
				i++;
				continue;
			}
			let worstQ = this.eRTQuality[i];
			for (let j = 1; j < seqBytes; j++) if (this.eRTQuality[i + j] > worstQ) worstQ = this.eRTQuality[i + j];
			chars.push(new TextDecoder('utf-8', { fatal: false }).decode(this.eRTBytes.slice(i, i + seqBytes)));
			cpQuality.push(worstQ);
			i += seqBytes;
		}
		return { chars, cpQuality };
	}

	private decodeTMC(blockB: number, bv: boolean[]): void {
		if (!bv[2] || !bv[3]) return;
		const blocks = this.getBlocks();
		const x = blockB & 0x1f;
		const y = blocks[2];
		const z = blocks[3];
		if ((x >> 4) & 1) return; // tuning info
		const f = (x >> 3) & 1;
		if (f) {
			this.cb({
				tmcMessage: {
					event: y & 0x7ff,
					location: z,
					direction: (y >> 14) & 1 ? 'negative' : 'positive',
					extent: (y >> 11) & 0x7,
					duration: x & 0x7,
					diversion: ((y >> 15) & 1) === 1,
					multi: false,
				},
			});
		} else {
			const ci = x & 0x7;
			if (ci !== this.tmcContinuity) {
				this.tmcContinuity = ci;
				this.tmcParts = [null, null, null, null, null];
			}
			const isFirst = (y >> 15) & 1;
			const sg = (y >> 14) & 1;
			let groupNum: number;
			let isLast: boolean;
			if (isFirst) {
				groupNum = 0;
				isLast = false;
			} else if (sg) {
				const gsi = (y >> 12) & 0x3;
				groupNum = 1;
				isLast = gsi === 0;
			} else {
				const gsi = (y >> 12) & 0x3;
				groupNum = 4 - gsi;
				isLast = gsi === 0;
			}
			this.tmcParts[groupNum] = { y, z };
			if (isLast && this.tmcParts[0]) {
				const p0 = this.tmcParts[0];
				this.cb({
					tmcMessage: {
						event: p0.y & 0x7ff,
						location: p0.z,
						direction: (p0.y >> 14) & 1 ? 'negative' : 'positive',
						extent: (p0.y >> 11) & 0x7,
						duration: 0,
						diversion: false,
						multi: true,
					},
				});
				this.tmcParts = [null, null, null, null, null];
			}
		}
	}

	private _rtPlusDecodeTags(b: number, c: number, d: number, running: number, srcText: string) {
		const type1 = ((b & 0x7) << 3) | (c >> 13);
		const start1 = (c >> 7) & 0x3f;
		const len1 = ((c >> 1) & 0x3f) + 1;
		const type2 = ((c & 1) << 5) | (d >> 11);
		const start2 = (d >> 5) & 0x3f;
		const len2 = (d & 0x1f) + 1;
		const ex = (s: number, l: number) => (s < srcText.length ? srcText.slice(s, Math.min(s + l, srcText.length)).trimEnd() : '');
		const t1 = type1 > 0 && running ? ex(start1, len1) : '';
		const t2 = type2 > 0 && running ? ex(start2, len2) : '';
		return { type1, type2, t1, t2, name1: RTPLUS_TYPES[type1] ?? `CT${type1}`, name2: RTPLUS_TYPES[type2] ?? `CT${type2}` };
	}

	private decodeRtPlus(b: number, c: number, d: number): void {
		const toggle = (b >> 4) & 1;
		const running = (b >> 3) & 1;
		const newItem = this.rtPlusToggle !== -1 && toggle !== this.rtPlusToggle;
		const runningChanged = this.rtPlusRunning !== -1 && running !== this.rtPlusRunning;
		this.rtPlusToggle = toggle;
		this.rtPlusRunning = running;
		const tags = this._rtPlusDecodeTags(b, c, d, running, this.getLastRt());
		if (
			tags.t1 !== this.rtPlusText1 ||
			tags.t2 !== this.rtPlusText2 ||
			tags.type1 !== this.rtPlusTag1 ||
			tags.type2 !== this.rtPlusTag2 ||
			newItem ||
			runningChanged
		) {
			if (newItem) {
				this.rtPlusText1 = '';
				this.rtPlusText2 = '';
				this.rtPlusTag1 = 0;
				this.rtPlusTag2 = 0;
			}
			this.rtPlusText1 = tags.t1;
			this.rtPlusText2 = tags.t2;
			this.rtPlusTag1 = tags.type1;
			this.rtPlusTag2 = tags.type2;
			this.cb({
				rtPlusRunning: running === 1,
				rtPlusToggle: toggle,
				rtPlusItem1: tags.t1,
				rtPlusItem1Tag: tags.type1 || undefined,
				rtPlusItem1Name: tags.type1 > 0 ? tags.name1 : undefined,
				rtPlusItem2: tags.t2,
				rtPlusItem2Tag: tags.type2 || undefined,
				rtPlusItem2Name: tags.type2 > 0 ? tags.name2 : undefined,
			});
		}
	}

	private decodeERtPlus(b: number, c: number, d: number): void {
		const toggle = (b >> 4) & 1;
		const running = (b >> 3) & 1;
		const newItem = this.eRTPlusToggle !== -1 && toggle !== this.eRTPlusToggle;
		const runningChanged = this.eRTPlusRunning !== -1 && running !== this.eRTPlusRunning;
		this.eRTPlusToggle = toggle;
		this.eRTPlusRunning = running;
		const src = this.eRTPlusCb === 1 ? this.lastERT : this.getLastRt();
		const tags = this._rtPlusDecodeTags(b, c, d, running, src);
		if (
			tags.t1 !== this.eRTPlusText1 ||
			tags.t2 !== this.eRTPlusText2 ||
			tags.type1 !== this.eRTPlusTag1 ||
			tags.type2 !== this.eRTPlusTag2 ||
			newItem ||
			runningChanged
		) {
			if (newItem) {
				this.eRTPlusText1 = '';
				this.eRTPlusText2 = '';
				this.eRTPlusTag1 = 0;
				this.eRTPlusTag2 = 0;
			}
			this.eRTPlusText1 = tags.t1;
			this.eRTPlusText2 = tags.t2;
			this.eRTPlusTag1 = tags.type1;
			this.eRTPlusTag2 = tags.type2;
			this.cb({
				eRTPlusRunning: running === 1,
				eRTPlusToggle: toggle,
				eRTPlusItem1: tags.t1,
				eRTPlusItem1Tag: tags.type1 || undefined,
				eRTPlusItem1Name: tags.type1 > 0 ? tags.name1 : undefined,
				eRTPlusItem2: tags.t2,
				eRTPlusItem2Tag: tags.type2 || undefined,
				eRTPlusItem2Name: tags.type2 > 0 ? tags.name2 : undefined,
			});
		}
	}
}
