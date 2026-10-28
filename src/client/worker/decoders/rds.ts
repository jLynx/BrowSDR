/* eslint-disable max-lines */
/*
Copyright (c) 2026, jLynx <https://github.com/jLynx>

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.
	Neither the name of Great Scott Gadgets nor the names of its contributors may be used to endorse or promote products derived from this software
	without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import type { RDSMessage, RdsStatus } from './types';
import { RDSOdaDecoder } from './rds-oda';
import { RDSDemodulator } from './rds-demod';
import { buildPS, buildRT, buildStatus, acceptChar as acceptCharFn } from './rds-utils';
import {
	PTY_LABELS_EU,
	PTY_LABELS_NA,
	LIC_NAMES,
	eccToCountry,
	COVERAGE_NAMES,
	rbdsCallsign,
	decodeAfCode,
	decodeLfMfCode,
	rdsChar,
} from './rds-tables';

export class RDSDecoder {
	private callback: (msg: RDSMessage) => void;
	private region: string;
	// Current group label injected into every callback as srcGroup
	private currentGroup = '';

	// 19 kHz pilot PLL — phasor rotation (zero trig calls per sample)

	// DSP demodulator -- see rds-demod.ts
	private readonly demod: RDSDemodulator;
	// Block data mirrored from demod for fast local access (readonly arrays, contents mutated)
	// Public for white-box unit tests that inject raw block data directly.
	readonly blocks: number[] = [0, 0, 0, 0];
	readonly blockValid: boolean[] = [false, false, false, false];
	private readonly blockCorrected: boolean[] = [false, false, false, false];
	// ODA accessor closures (class fields so they bind `this` correctly)
	private readonly _getOdaBlocks = () => this.blocks;
	private readonly _getOdaBlockValid = () => this.blockValid;
	private readonly _getOdaBlockQuality = (idx: number) => (this.blockValid[idx] ? (this.blockCorrected[idx] ? 1 : 0) : 2) as number;
	private readonly _getOdaLastRt = () => this.lastRt;

	// ODA decoders (RT+, eRT+, eRT, TMC) -- see rds-oda.ts
	private readonly oda: RDSOdaDecoder;

	// ── Decoded RDS data ──────────────────────────────────────────
	private pi = 0;
	private pty = -1;
	private tp: boolean | null = null;
	private ta: boolean | null = null;
	private psChars: Array<string | null> = new Array<string | null>(8).fill(null);
	private psStatus: number[] = new Array<number>(8).fill(0);
	private rtChars: Array<string | null> = new Array<string | null>(64).fill(null);
	private rtStatus: number[] = new Array<number>(64).fill(0);
	private rtAbFlag = -1;
	private rtVersion = -1;
	private lastPs = '';
	private lastRt = '';

	// Group 1A — ECC, LIC
	private ecc = -1;
	private lic = -1;

	// Group 0A — AF list
	private afList: number[] = [];
	private afCount = 0;
	private afLastCount = -1;
	// Group 0/15B — MS and DI
	private ms = -1;
	private diWord = -1;
	private diBits = new Int8Array(4).fill(-1);

	// Group 3A — ODA application registration: (groupNum<<1)|version → AID
	private odaMap: Map<number, number> = new Map();
	private odaMsg: Map<number, number> = new Map();

	// Group 4A — CT clock
	private lastCt = '';

	// Group 10A — PTYN
	private ptynChars: Array<string | null> = new Array<string | null>(8).fill(null);
	private ptynStatus: number[] = new Array<number>(8).fill(0);
	private lastPtyn = '';
	private ptynAbFlag = -1;

	// Group 14A — EON
	private eonMap: Map<
		number,
		{
			psChars: Array<string | null>;
			tp: boolean;
			ta: boolean;
			af: number[];
			mappedFreqs: Array<{ tuned: number; other: number }>;
			ptyOn: number;
			pinDay: number;
			pinHour: number;
			pinMinute: number;
			// Variant 12: Linkage Set Number and flags
			lsn: number;
			lsIls: boolean;
			lsEg: boolean;
			lsLa: boolean;
			lastKey: string;
		}
	> = new Map();

	constructor(sampleRate: number, callback: (msg: RDSMessage) => void, region = 'eu') {
		// Wrap callback to auto-inject srcGroup from the current group being decoded
		this.callback = (msg: RDSMessage) => callback({ srcGroup: this.currentGroup || undefined, ...msg });
		this.region = region;

		// DSP demodulator calls back when a complete group is assembled
		this.demod = new RDSDemodulator(sampleRate, (blks, bv, bc) => {
			// Mirror demod block data to local fields for type-safe access
			for (let i = 0; i < 4; i++) {
				this.blocks[i] = blks[i];
				this.blockValid[i] = bv[i];
				this.blockCorrected[i] = bc[i];
			}
			this._decodeGroup();
		});

		// Initialize ODA decoder (RT+, eRT+, eRT, TMC)
		this.oda = new RDSOdaDecoder(this._getOdaBlocks, this._getOdaBlockValid, this._getOdaBlockQuality, this._getOdaLastRt, this.callback);
	}

	setRegion(region: string): void {
		if (region === this.region) return;
		this.region = region;
		if (this.pi) {
			this.callback({ piCallsign: region === 'na' ? (rbdsCallsign(this.pi) ?? undefined) : undefined });
		}
		if (this.pty >= 0) {
			const labels = region === 'na' ? PTY_LABELS_NA : PTY_LABELS_EU;
			this.callback({ pty: this.pty, ptyLabel: labels[this.pty] || '' });
		}
	}

	process(samples: Float32Array): void {
		this.demod.process(samples);
	}

	/** Feed a single biphase bit directly, bypassing the MPX demodulator (for unit tests). */
	processBit(bit: number): void {
		this.demod.processBit(bit);
	}

	/** Decode the current block data (for unit tests that set blocks/blockValid directly). */
	decodeGroup(): void {
		this._decodeGroup();
	}

	/** Return the current accumulated RadioText string (for unit tests). */
	buildRT(): string | null {
		return buildRT(this.rtChars);
	}
	// quality: 0=clean block, 1=BCH-corrected, 2=uncorrectable/lost
	private _handlePiChange(pi: number): void {
		if (pi === this.pi || pi === 0) return;
		this.psChars.fill(null);
		this.psStatus.fill(0);
		this.rtChars.fill(null);
		this.rtStatus.fill(0);
		this.ptynChars.fill(null);
		this.ptynStatus.fill(0);
		this.lastPs = '';
		this.lastRt = '';
		this.lastPtyn = '';
		this.lastCt = '';
		this.rtAbFlag = -1;
		this.rtVersion = -1;
		this.ecc = -1;
		this.lic = -1;
		this.afList = [];
		this.afCount = 0;
		this.afLastCount = -1;
		this.odaMap.clear();
		this.eonMap.clear();
		this.odaMsg.clear();
		this.oda.reset();
		this.pi = pi;
		const piCc = (pi >> 12) & 0xf;
		const piCoverage = (pi >> 8) & 0xf;
		this.callback({
			pi: pi.toString(16).toUpperCase().padStart(4, '0'),
			piCc,
			piCoverage,
			piCoverageName: COVERAGE_NAMES[piCoverage] ?? '--',
			piRef: pi & 0xff,
			piCallsign: this.region === 'na' ? (rbdsCallsign(pi) ?? undefined) : undefined,
		});
	}

	private _decodeGroup(): void {
		const bv = this.blockValid;
		if (bv[0]) this._handlePiChange(this.blocks[0]);
		if (!bv[1]) return;
		const blockB = this.blocks[1];
		const groupType = (blockB >> 12) & 0xf;
		const version = (blockB >> 11) & 1;
		this.currentGroup = `${groupType}${version === 0 ? 'A' : 'B'}`;
		this._handleTpPty(blockB);
		this._dispatchGroup(groupType, version, blockB, bv);
	}

	private _handleTpPty(blockB: number): void {
		const tp = ((blockB >> 10) & 1) === 1;
		const pty = (blockB >> 5) & 0x1f;
		if (tp !== this.tp) {
			this.tp = tp;
			this.callback({ tp, srcGroup: this.currentGroup });
		}
		if (pty !== this.pty) {
			this.pty = pty;
			const labels = this.region === 'na' ? PTY_LABELS_NA : PTY_LABELS_EU;
			this.callback({ pty, ptyLabel: labels[pty] || '', srcGroup: this.currentGroup });
		}
	}

	private _dispatchGroup(groupType: number, version: number, blockB: number, bv: boolean[]): void {
		switch (groupType) {
			case 0:
				this.decodeGroup0(version, blockB, bv);
				break;
			case 1:
				if (version === 0) this.decodeGroup1A(blockB, bv);
				else this.decodeGroup1B(blockB, bv);
				break;
			case 2:
				this.decodeGroup2(version, blockB, bv);
				break;
			case 3:
				if (version === 0) this.decodeGroup3A(blockB, bv);
				break;
			case 4:
				if (version === 0) this.decodeGroup4A(bv);
				break;
			case 7:
				if (version === 0 && this.rpc > 0) this.decodeGroup7A(blockB, bv);
				break;
			case 10:
				if (version === 0) this.decodeGroup10A(blockB, bv);
				break;
			case 14:
				if (version === 0) this.decodeGroup14A(blockB, bv);
				else this.decodeGroup14B(blockB, bv);
				break;
			case 15:
				if (version === 1) this.decodeGroup15B(blockB);
				break;
			default:
				this.decodeOdaGroup(groupType, version, blockB, bv);
				break;
		}
	}

	/** 0=clean, 1=BCH-corrected, 2=invalid/lost. */
	private blockQuality(idx: number): number {
		if (!this.blockValid[idx]) return 2;
		return this.blockCorrected[idx] ? 1 : 0;
	}

	// ── Group 0: PS name + TA + MS + DI ─────────────────────────
	private decodeGroup0(version: number, blockB: number, bv: boolean[]): void {
		const ta = (blockB & 0x10) !== 0;
		if (ta !== this.ta) {
			this.ta = ta;
			this.callback({ ta });
		}

		// M/S (Music/Speech) switch: block B bit 3
		const ms = (blockB & 0x08) !== 0;
		if (ms !== (this.ms === 1)) {
			this.ms = ms ? 1 : 0;
			this.callback({ ms });
		}

		// DI bit: block B bit 2; segment address from bits [1:0]
		// 4 groups assemble d3(seg0) d2(seg1) d1(seg2) d0(seg3) -- MSB first
		// seg=C1C0: 00->d3, 01->d2, 10->d1, 11->d0
		const seg = blockB & 0x03;
		const diBit = (blockB >> 2) & 1;
		// d3 is transmitted in seg=0, d2 in seg=1, d1 in seg=2, d0 in seg=3
		this.diBits[3 - seg] = diBit;
		if (!this.diBits.includes(-1)) {
			const di = (this.diBits[3] << 3) | (this.diBits[2] << 2) | (this.diBits[1] << 1) | this.diBits[0];
			if (di !== this.diWord) {
				this.diWord = di;
				this.callback({
					di,
					diStereo: (di & 1) !== 0,
					diArtHead: (di & 2) !== 0,
					diCompressed: (di & 4) !== 0,
					diDynPty: (di & 8) !== 0,
				});
			}
		}

		// AF Method A in block C (version 0 only)
		if (version === 0 && bv[2]) {
			const c = this.blocks[2];
			this.processAfPair((c >> 8) & 0xff, c & 0xff);
		}

		// PS name in block D
		if (bv[3]) {
			const d = this.blocks[3];
			const q = this.blockQuality(3);
			acceptCharFn(seg * 2, (d >> 8) & 0xff, this.psChars, this.psStatus, q, this.rtChars, this.region);
			acceptCharFn(seg * 2 + 1, d & 0xff, this.psChars, this.psStatus, q, this.rtChars, this.region);
			const ps = buildPS(this.psChars);
			if (ps && ps !== this.lastPs) {
				this.lastPs = ps;
				this.callback({ ps, psCharStatus: [...this.psStatus] });
			}
		}
	}

	// ── Group 15B: Fast basic tuning (TA + MS + DI, no PS/AF) ───
	private decodeGroup15B(blockB: number): void {
		const ta = (blockB & 0x10) !== 0;
		if (ta !== this.ta) {
			this.ta = ta;
			this.callback({ ta });
		}
		const ms = (blockB & 0x08) !== 0;
		if (ms !== (this.ms === 1)) {
			this.ms = ms ? 1 : 0;
			this.callback({ ms });
		}
		const seg = blockB & 0x03;
		const diBit = (blockB >> 2) & 1;
		this.diBits[3 - seg] = diBit;
		if (!this.diBits.includes(-1)) {
			const di = (this.diBits[3] << 3) | (this.diBits[2] << 2) | (this.diBits[1] << 1) | this.diBits[0];
			if (di !== this.diWord) {
				this.diWord = di;
				this.callback({ di, diStereo: (di & 1) !== 0, diArtHead: (di & 2) !== 0, diCompressed: (di & 4) !== 0, diDynPty: (di & 8) !== 0 });
			}
		}
	}

	private afLfMfNext = false; // true when previous code was 250 (LF/MF follows)
	private afMethodB = false; // true when transmitting in Method B (tuning freq pairs)

	private processAfPair(a: number, b: number): void {
		// Handle LF/MF carry-over from previous pair (code 250 preceded this)
		if (this.afLfMfNext) {
			const fa = decodeLfMfCode(a, this.region);
			if (fa !== null && !this.afList.includes(fa)) this.afList.push(fa);
			this.afLfMfNext = false;
			a = b;
			b = 0; // b is now the next normal code
		}

		// Method B: first code is tuning freq (TN), second is alternative freq (ON)
		if (a >= 1 && a <= 204 && this.afMethodB) {
			const fb = decodeAfCode(b, this.region);
			if (fb !== null && !this.afList.includes(fb)) {
				this.afList.push(fb);
				this.callback({ af: [...this.afList], afMethod: 'B' });
			}
			return;
		}

		// Method A / control codes -- process each code independently
		this._applyAfSingleCode(a);
		if (!this.afLfMfNext) this._applyAfSingleCode(b);

		// Detect Method B from first FM code without a preceding count
		if (!this.afMethodB && a >= 1 && a <= 204 && this.afCount <= 0) this.afMethodB = true;

		if (this.afList.length > 0 && (this.afCount <= 0 || this.afList.length >= this.afCount))
			this.callback({ af: [...this.afList], afMethod: this.afMethodB ? 'B' : 'A' });
	}
	/** Apply a single AF code (not Method B TN/ON pair). Modifies afList and emits when ready. */
	private _applyAfSingleCode(code: number): void {
		if (code === 205 || code === 0) return; // filler / consumed
		if (code === 224) {
			if (this.afList.length !== 0) {
				this.afList = [];
				this.callback({ af: [] });
			}
		} else if (code >= 225 && code <= 249) {
			const count = code - 224;
			if (count !== this.afLastCount) {
				this.afLastCount = count;
				this.afCount = count;
				this.afList = [];
				this.afMethodB = false;
			}
		} else if (code === 250) {
			this.afLfMfNext = true;
		} else if (code >= 1 && code <= 204) {
			const f = decodeAfCode(code, this.region);
			if (f !== null && !this.afList.includes(f)) this.afList.push(f);
		}
	}
	// 1A paging state (suppress duplicate callbacks)
	private rpc = -1;
	private la = false;
	private opc0 = -1; // OPC from variant 0 (ECC block)
	private pagingOpc = -1;
	private pagingPac = -1;
	private ewsChannel = -1;
	private broadcasterData = -1;
	private lastTmcId = -1;
	private lastPin = -1;

	private decodeGroup1A(blockB: number, bv: boolean[]): void {
		// Block B bits [4:0]: Radio Paging Codes (EN 50067 Annex M, M.2.1.1.2)
		//   bits [4:2]: transmitter network group designation (0=no paging)
		//   bits [1:0]: battery-saving interval sync
		const rpc = blockB & 0x1f;
		if (rpc !== this.rpc) {
			this.rpc = rpc;
			this.callback({
				rpc,
				rpcGroupDesig: (rpc >> 2) & 0x7,
				rpcBattSync: rpc & 0x3,
			});
		}

		// Block D: Programme Item Number (day[15:11] hour[10:6] minute[5:0])
		// Broadcast once per second -- suppress if unchanged.
		// pinDay=0 means no valid PIN (spec page 24 note 3).
		if (bv[3]) {
			const pin = this.blocks[3];
			if (pin !== this.lastPin) {
				this.lastPin = pin;
				const pinDay = (pin >> 11) & 0x1f;
				this.callback({ pin, pinDay, pinHour: (pin >> 6) & 0x1f, pinMinute: pin & 0x3f });
			}
		}

		if (!bv[2]) return;
		const c = this.blocks[2];

		// Block C bit [15]: Linkage Actuator (LA) -- present on ALL variants
		const la = ((c >> 15) & 1) !== 0;
		if (la !== this.la) {
			this.la = la;
			this.callback({ la });
		}

		// Block C bits [14:12]: variant code; bits [11:0]: payload
		const variant = (c >> 12) & 0x7;
		this._decode1AVariant(variant, c & 0x0fff);
	}

	private _decode1AVariant(variant: number, payload: number): void {
		if (variant <= 3) {
			this._decode1AVariantLow(variant, payload);
			return;
		}
		switch (variant) {
			case 6: {
				const bd = payload;
				if (bd !== this.broadcasterData) {
					this.broadcasterData = bd;
					this.callback({ broadcasterData: bd });
				}
				break;
			}
			case 7: {
				const ews = payload;
				if (ews !== this.ewsChannel) {
					this.ewsChannel = ews;
					this.callback({ ewsChannel: ews });
				}
				break;
			}
		}
	}

	private _decode1AVariantLow(variant: number, payload: number): void {
		switch (variant) {
			case 0: {
				const ecc = payload & 0xff;
				const opc = (payload >> 8) & 0xf;
				if (ecc !== this.ecc || opc !== this.opc0) {
					if (ecc !== this.ecc) this.ecc = ecc;
					if (opc !== this.opc0) this.opc0 = opc;
					this.callback({ ecc, opc, countryName: eccToCountry(this.pi, ecc) });
				}
				break;
			}
			case 1: {
				const tmcId = payload;
				if (tmcId !== this.lastTmcId) {
					this.lastTmcId = tmcId;
					this.callback({ hasTmc: true, tmcId });
				}
				break;
			}
			case 2: {
				const opc = (payload >> 8) & 0xf;
				const pac = payload & 0x3f;
				if (opc !== this.pagingOpc || pac !== this.pagingPac) {
					this.pagingOpc = opc;
					this.pagingPac = pac;
					this.callback({ pagingOpc: opc, pagingPac: pac });
				}
				break;
			}
			case 3: {
				// RDS/RBDS: variant 3 = Language Identification Code (IEC 62106 §3.2.1.3)
				// NRSC-4-B does not redefine group 1A, so LIC is valid in both regions.
				const lic = payload & 0xff;
				if (lic !== this.lic) {
					this.lic = lic;
					this.callback({ lic, languageName: LIC_NAMES[lic] || 'Unknown' });
				}
				break;
			}
		}
	}

	private decodeGroup1B(blockB: number, bv: boolean[]): void {
		// Block B bits [4:0]: spare bits (reserved for future use, should be 0)
		// Block D: PIN -- same layout as 1A, suppress if unchanged
		void blockB;
		if (bv[3]) {
			const pin = this.blocks[3];
			if (pin !== this.lastPin) {
				this.lastPin = pin;
				const pinDay = (pin >> 11) & 0x1f;
				this.callback({ pin, pinDay, pinHour: (pin >> 6) & 0x1f, pinMinute: pin & 0x3f });
			}
		}
	}

	// ── Group 2: RadioText ───────────────────────────────────────
	private decodeGroup2(version: number, blockB: number, bv: boolean[]): void {
		const abFlag = (blockB >> 4) & 1;
		if (abFlag !== this.rtAbFlag || version !== this.rtVersion) {
			this.rtChars.fill(null);
			this.rtStatus.fill(0);
			this.lastRt = '';
			// RT A/B flip invalidates RT+ tag positions (they reference old RT)
			this.oda.clearRtPlus();
		}
		this.rtAbFlag = abFlag;
		this.rtVersion = version;
		const seg = blockB & 0x0f;
		if (version === 0) {
			if (bv[2]) {
				const c = this.blocks[2];
				const q = this.blockQuality(2);
				acceptCharFn(seg * 4, (c >> 8) & 0xff, this.rtChars, this.rtStatus, q, this.rtChars, this.region);
				acceptCharFn(seg * 4 + 1, c & 0xff, this.rtChars, this.rtStatus, q, this.rtChars, this.region);
			}
			if (bv[3]) {
				const d = this.blocks[3];
				const q = this.blockQuality(3);
				acceptCharFn(seg * 4 + 2, (d >> 8) & 0xff, this.rtChars, this.rtStatus, q, this.rtChars, this.region);
				acceptCharFn(seg * 4 + 3, d & 0xff, this.rtChars, this.rtStatus, q, this.rtChars, this.region);
			}
		} else if (bv[3]) {
			const d = this.blocks[3];
			const q = this.blockQuality(3);
			acceptCharFn(seg * 2, (d >> 8) & 0xff, this.rtChars, this.rtStatus, q, this.rtChars, this.region);
			acceptCharFn(seg * 2 + 1, d & 0xff, this.rtChars, this.rtStatus, q, this.rtChars, this.region);
		}
		const rt = buildRT(this.rtChars);
		if (rt && rt.length >= 4 && rt !== this.lastRt) {
			this.lastRt = rt;
			this.callback({ rt, rtCharStatus: buildStatus(this.rtChars, this.rtStatus), srcAbFlag: abFlag });
		}
	}

	// ── Group 3A: ODA application identification ─────────────────
	private decodeGroup3A(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const odaGroupNum = (blockB >> 1) & 0xf;
		const odaVersion = blockB & 1;
		const aid = this.blocks[3];
		// Block C = 16-bit message bits (app-specific config, e.g. RT+ CB/SCB/template)
		const msg = bv[2] ? this.blocks[2] : 0;
		const key = (odaGroupNum << 1) | odaVersion;
		// Only emit when this group's AID or message bits change
		if (this.odaMap.get(key) === aid && this.odaMsg.get(key) === msg) return;
		this.odaMap.set(key, aid);
		this.odaMsg.set(key, msg);
		if (aid === 0x4bd7) this.oda.rtPlusGroup = key;
		if (aid === 0x4bd8) {
			this.oda.eRTPlusGroup = key;
			this.oda.eRTPlusCb = (msg >> 12) & 1;
		}
		if (aid === 0x6552) this.oda.eRTGroup = key;
		if (aid === 0x4d2c || aid === 0xcd46 || aid === 0xcd47) this.oda.tmcGroup = key;
		this.callback({ odaAid: aid, odaGroup: odaGroupNum, odaVersion, odaMsg: msg });
	}

	// ── Group 4A: Clock Time (CT) ────────────────────────────────
	private decodeGroup4A(bv: boolean[]): void {
		if (!bv[1] || !bv[2] || !bv[3]) return;
		const b = this.blocks[1],
			c = this.blocks[2],
			d = this.blocks[3];
		// Modified Julian Day from blocks B+C
		const mjd = ((b & 0x3) << 15) | (c >> 1);
		const hours = ((c & 1) << 4) | (d >> 12);
		const minutes = (d >> 6) & 0x3f;
		const offsetHalf = d & 0x1f; // magnitude in bits [4:0], units of 0.5h
		const utcOffset = d & 0x20 ? -offsetHalf : offsetHalf; // bit 5: 0=+East, 1=-West
		// MJD to Gregorian calendar (IEC 62106 Annex G)
		const yp = Math.trunc((mjd - 15078.2) / 365.25);
		const mp = Math.trunc((mjd - 14956.1 - Math.trunc(yp * 365.25)) / 30.6001);
		const day = mjd - 14956 - Math.trunc(yp * 365.25) - Math.trunc(mp * 30.6001);
		const k = mp === 14 || mp === 15 ? 1 : 0;
		const year = yp + k + 1900;
		const month = mp - 1 - k * 12;
		const p2 = (n: number) => String(n).padStart(2, '0');
		const ct = `${year}-${p2(month)}-${p2(day)} ${p2(hours)}:${p2(minutes)}`;
		if (ct !== this.lastCt) {
			this.lastCt = ct;
			this.callback({ ct, ctUtcOffset: utcOffset });
		}
	}

	// ── Group 10A: Programme Type Name (PTYN) ────────────────────
	private decodeGroup10A(blockB: number, bv: boolean[]): void {
		// A/B flag in bit 4: toggle clears PTYN buffer (new PTYN starting)
		const abFlag = (blockB >> 4) & 1;
		if (abFlag !== this.ptynAbFlag) {
			this.ptynAbFlag = abFlag;
			this.ptynChars.fill(null);
			this.ptynStatus.fill(0);
			this.lastPtyn = '';
		}
		const seg = blockB & 1;
		if (bv[2]) {
			const c = this.blocks[2];
			const q = this.blockQuality(2);
			acceptCharFn(seg * 4, (c >> 8) & 0xff, this.ptynChars, this.ptynStatus, q, this.rtChars, this.region);
			acceptCharFn(seg * 4 + 1, c & 0xff, this.ptynChars, this.ptynStatus, q, this.rtChars, this.region);
		}
		if (bv[3]) {
			const d = this.blocks[3];
			const q = this.blockQuality(3);
			acceptCharFn(seg * 4 + 2, (d >> 8) & 0xff, this.ptynChars, this.ptynStatus, q, this.rtChars, this.region);
			acceptCharFn(seg * 4 + 3, d & 0xff, this.ptynChars, this.ptynStatus, q, this.rtChars, this.region);
		}
		if (!this.ptynChars.includes(null)) {
			const ptyn = (this.ptynChars as string[]).join('').trimEnd();
			if (ptyn && ptyn !== this.lastPtyn) {
				this.lastPtyn = ptyn;
				this.callback({ ptyn, ptynCharStatus: [...this.ptynStatus], srcAbFlag: this.ptynAbFlag });
			}
		}
	}

	// ── Group 14A: Enhanced Other Networks (EON) ─────────────────
	private decodeGroup14A(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const eonPi = this.blocks[3];
		if (!eonPi) return;
		if (!this.eonMap.has(eonPi))
			this.eonMap.set(eonPi, {
				psChars: new Array<string | null>(8).fill(null),
				tp: false,
				ta: false,
				af: [],
				mappedFreqs: [],
				ptyOn: -1,
				pinDay: 0,
				pinHour: 0,
				pinMinute: 0,
				lsn: -1,
				lsIls: false,
				lsEg: false,
				lsLa: false,
				lastKey: '',
			});
		const eon = this.eonMap.get(eonPi)!;
		const variant = blockB & 0xf;
		eon.tp = ((blockB >> 4) & 1) === 1;
		if (bv[2]) this._eon14AApplyVariant(variant, eon, this.blocks[2]);

		const ps = eon.psChars.every((ch) => ch !== null) ? eon.psChars.join('') : undefined;
		const key = `${eonPi}:${ps}:${eon.tp}:${eon.ta}:${eon.af.join(',')}:${eon.mappedFreqs.length}:${eon.ptyOn}:${eon.pinDay}:${eon.lsn}`;
		if (eon.lastKey === key) return;
		eon.lastKey = key;
		this.callback({
			eon: {
				pi: eonPi.toString(16).toUpperCase().padStart(4, '0'),
				ps,
				tp: eon.tp,
				ta: eon.ta,
				af: eon.af.length ? [...eon.af] : undefined,
				mappedFreqs: eon.mappedFreqs.length ? [...eon.mappedFreqs] : undefined,
				ptyOn: eon.ptyOn >= 0 ? eon.ptyOn : undefined,
				pinDay: eon.pinDay > 0 ? eon.pinDay : undefined,
				pinHour: eon.pinDay > 0 ? eon.pinHour : undefined,
				pinMinute: eon.pinDay > 0 ? eon.pinMinute : undefined,
				lsn: eon.lsn >= 0 ? eon.lsn : undefined,
				lsIls: eon.lsn >= 0 && eon.lsIls ? true : undefined,
				lsEg: eon.lsn >= 0 && eon.lsEg ? true : undefined,
				lsLa: eon.lsn >= 0 && eon.lsLa ? true : undefined,
			},
		});
	}

	private _eon14AApplyVariant(variant: number, eon: NonNullable<ReturnType<typeof this.eonMap.get>>, c: number): void {
		if (variant <= 3) {
			eon.psChars[variant * 2] = rdsChar((c >> 8) & 0xff, this.region);
			eon.psChars[variant * 2 + 1] = rdsChar(c & 0xff, this.region);
		} else if (variant === 4) {
			const fa = decodeAfCode((c >> 8) & 0xff, this.region);
			const fb = decodeAfCode(c & 0xff, this.region);
			if (fa !== null && !eon.af.includes(fa)) eon.af.push(fa);
			if (fb !== null && !eon.af.includes(fb)) eon.af.push(fb);
		} else if (variant >= 5 && variant <= 8) {
			const tuned = decodeAfCode((c >> 8) & 0xff, this.region);
			const other = decodeAfCode(c & 0xff, this.region);
			if (tuned !== null && other !== null && !eon.mappedFreqs.some((p) => p.tuned === tuned && p.other === other))
				eon.mappedFreqs.push({ tuned, other });
		} else if (variant === 9) {
			const tuned = decodeAfCode((c >> 8) & 0xff, this.region);
			const other = decodeLfMfCode(c & 0xff, this.region);
			if (tuned !== null && other !== null && !eon.mappedFreqs.some((p) => p.tuned === tuned && p.other === other))
				eon.mappedFreqs.push({ tuned, other });
		} else if (variant === 12) {
			eon.lsn = c & 0x0fff;
			eon.lsIls = ((c >> 12) & 1) === 1;
			eon.lsEg = ((c >> 14) & 1) === 1;
			eon.lsLa = ((c >> 15) & 1) === 1;
		} else if (variant === 13) {
			eon.ta = (c & 1) === 1;
			eon.ptyOn = (c >> 11) & 0x1f;
		} else if (variant === 14) {
			eon.pinDay = (c >> 11) & 0x1f;
			eon.pinHour = (c >> 6) & 0x1f;
			eon.pinMinute = c & 0x3f;
		}
		// Variants 10, 11, 15: unallocated / broadcaster -- no action
	}

	// ── Group 14B: EON TA quick-update ──────────────────────────
	// Figure 38: TP(TN) in block B bit 4, TA(ON) in block B bit 3, PI(ON) in block D
	private decodeGroup14B(blockB: number, bv: boolean[]): void {
		if (!bv[3]) return;
		const eonPi = this.blocks[3];
		if (!eonPi) return;
		if (!this.eonMap.has(eonPi))
			this.eonMap.set(eonPi, {
				psChars: new Array<string | null>(8).fill(null),
				tp: false,
				ta: false,
				af: [],
				mappedFreqs: [],
				ptyOn: -1,
				pinDay: 0,
				pinHour: 0,
				pinMinute: 0,
				lsn: -1,
				lsIls: false,
				lsEg: false,
				lsLa: false,
				lastKey: '',
			});
		const eon = this.eonMap.get(eonPi)!;
		eon.tp = ((blockB >> 4) & 1) === 1;
		eon.ta = ((blockB >> 3) & 1) === 1;
		const key = `${eonPi}::${eon.tp}:${eon.ta}:`;
		if (eon.lastKey === key) return;
		eon.lastKey = key;
		this.callback({
			eon: {
				pi: eonPi.toString(16).toUpperCase().padStart(4, '0'),
				tp: eon.tp,
				ta: eon.ta,
			},
		});
	}
	// ── Group 7A: Radio Paging (EN 50067 Annex M) ────────────────
	// Gate: only active when rpcGroupDesig>0 (1A bits[4:2]!=0) AND CT received.
	// Per 3.2.6.2.2: all three of 4A(CT), 1A(RPC), 7A must be present.
	private pagAbFlag = -1;
	private pagAssembling = false;
	private pagAddress = 0;
	private pagAddrFmt = '';
	private pagMsgType = ''; // 'tone'|'num10'|'num18'|'intl15'|'alpha'|'vnum'|'functions'
	private pagMsg = '';
	private pagExpectedPsac = -1;
	private pagCountryCode = ''; // X1X2X3 for INTL15 and functions messages

	/** Unpack 6-digit pager address from block C + block D high byte */
	private pagUnpackAddr(c: number, dHi: number): number {
		return (
			((c >> 12) & 0xf) * 100000 +
			((c >> 8) & 0xf) * 10000 +
			((c >> 4) & 0xf) * 1000 +
			(c & 0xf) * 100 +
			((dHi >> 4) & 0xf) * 10 +
			(dHi & 0xf)
		);
	}

	/** Decode BCD nibbles to digit string (0xA = space) */
	private pagBcd(nibbles: number[]): string {
		return nibbles.map((n) => (n <= 9 ? String(n) : ' ')).join('');
	}

	/** Decode hex nibbles to string (0x0-0x9='0'-'9', 0xA-0xF='A'-'F') per Annex M */
	private pagHex(nibbles: number[]): string {
		return nibbles.map((n) => n.toString(16).toUpperCase()).join('');
	}

	private decodeGroup7A(blockB: number, bv: boolean[]): void {
		if (!bv[2] || !bv[3]) return;
		const abFlag = (blockB >> 4) & 1;
		const psac = blockB & 0xf;
		const c = this.blocks[2];
		const d = this.blocks[3];

		if (this.pagAssembling && abFlag !== this.pagAbFlag) {
			this.pagAssembling = false;
			this.pagMsg = '';
		}
		this.pagAbFlag = abFlag;

		const isAddrGroup = psac === 0x0 || psac === 0x1 || psac === 0x2 || psac === 0x4 || psac === 0x7 || psac === 0x8;
		if (isAddrGroup) {
			const addr = this.pagUnpackAddr(c, (d >> 8) & 0xff);
			this.pagAddrFmt = `${String(Math.trunc(addr / 10000)).padStart(2, '0')}-${String(addr % 10000).padStart(4, '0')}`;
			this._pag7AAddrGroup(psac, addr, d);
		} else {
			this._pag7ADataGroup(psac, c, d);
		}
	}

	/** Handle Group 7A address groups (PSAC 0/1/2/4/7/8). */
	private _pag7AAddrGroup(psac: number, addr: number, d: number): void {
		switch (psac) {
			case 0x0:
				this.callback({ paging: { address: addr, type: 'tone', data: '', addrFmt: this.pagAddrFmt } });
				break;
			case 0x1:
				this.pagAddress = addr;
				this.pagCountryCode = this.pagBcd([(d >> 4) & 0xf, d & 0xf]);
				this.pagMsg = '';
				this.pagMsgType = 'functions';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x3;
				break;
			case 0x2:
				this.pagAddress = addr;
				this.pagMsg = this.pagBcd([(d >> 4) & 0xf, d & 0xf]);
				this.pagMsgType = 'num10';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x3;
				break;
			case 0x4:
				this.pagAddress = addr;
				this.pagMsg = this.pagBcd([(d >> 4) & 0xf, d & 0xf]);
				this.pagMsgType = 'num18';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x5;
				break;
			case 0x7:
				this.pagAddress = addr;
				this.pagCountryCode = this.pagBcd([(d >> 4) & 0xf, d & 0xf]);
				this.pagMsg = '';
				this.pagMsgType = 'intl15';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x5;
				break;
			case 0x8: {
				const mt = (d & 0xff) >> 6;
				this.pagAddress = addr;
				this.pagMsg = '';
				this.pagMsgType = mt === 1 ? 'vnum' : mt === 3 ? 'functions' : 'alpha';
				this.pagAssembling = true;
				this.pagExpectedPsac = 0x9;
				break;
			}
		}
	}

	/** Handle Group 7A data groups (PSAC 3/5/6/F/default). */
	private _pag7ADataGroup(psac: number, c: number, d: number): void {
		const nibs8 = () => [
			(c >> 12) & 0xf,
			(c >> 8) & 0xf,
			(c >> 4) & 0xf,
			c & 0xf,
			(d >> 12) & 0xf,
			(d >> 8) & 0xf,
			(d >> 4) & 0xf,
			d & 0xf,
		];
		const ascii4 = () =>
			[(c >> 8) & 0xff, c & 0xff, (d >> 8) & 0xff, d & 0xff].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '')).join('');
		switch (psac) {
			case 0x3:
				if (this.pagAssembling) this._pag7A3Data(c, d, nibs8());
				break;
			case 0x5:
			case 0x6:
				if (this.pagAssembling && psac === this.pagExpectedPsac) this._pag7A56Data(psac, c, d, nibs8());
				break;
			case 0xf:
				if (!this.pagAssembling) break;
				if (this.pagMsgType === 'alpha') {
					this.pagMsg += ascii4();
					this.pagMsg = this.pagMsg.trimEnd();
					this.pagAssembling = false;
					this.callback({ paging: { address: this.pagAddress, type: 'alpha', data: this.pagMsg, addrFmt: this.pagAddrFmt } });
				} else if (this.pagMsgType === 'vnum') {
					this.pagMsg += this.pagBcd(nibs8());
					this.pagMsg = this.pagMsg.trim();
					this.pagAssembling = false;
					this.callback({ paging: { address: this.pagAddress, type: 'vnum', data: this.pagMsg, addrFmt: this.pagAddrFmt } });
				}
				break;
			default:
				if (psac >= 0x9 && psac <= 0xe && this.pagAssembling) {
					if (this.pagMsgType === 'alpha') {
						this.pagMsg += ascii4();
						this.pagExpectedPsac = psac + 1;
					} else if (this.pagMsgType === 'vnum') {
						this.pagMsg += this.pagBcd(nibs8());
						this.pagExpectedPsac = psac + 1;
					}
				}
				break;
		}
	}

	private _pag7A3Data(c: number, d: number, nibs8: number[]): void {
		if (this.pagMsgType === 'num10') {
			this.pagMsg += this.pagBcd(nibs8);
			this.pagAssembling = false;
			this.callback({ paging: { address: this.pagAddress, type: 'num10', data: this.pagMsg.trim(), addrFmt: this.pagAddrFmt } });
		} else if (this.pagMsgType === 'functions') {
			const x3 = this.pagHex([(c >> 12) & 0xf]);
			const f = [(c >> 8) & 0xf, (c >> 4) & 0xf, c & 0xf, (d >> 12) & 0xf, (d >> 8) & 0xf, (d >> 4) & 0xf, d & 0xf];
			this.pagCountryCode += x3;
			this.pagAssembling = false;
			this.callback({
				paging: {
					address: this.pagAddress,
					type: 'functions',
					data: `CC:${this.pagCountryCode} F:${this.pagHex(f)}`,
					addrFmt: this.pagAddrFmt,
				},
			});
		}
	}

	private _pag7A56Data(psac: number, c: number, d: number, nibs8: number[]): void {
		if (this.pagMsgType === 'num18') {
			this.pagMsg += this.pagBcd(nibs8);
			if (psac === 0x6) {
				this.pagAssembling = false;
				this.callback({ paging: { address: this.pagAddress, type: 'num18', data: this.pagMsg.trim(), addrFmt: this.pagAddrFmt } });
			} else this.pagExpectedPsac = 0x6;
		} else if (this.pagMsgType === 'intl15') {
			if (psac === 0x5) {
				const x3 = this.pagBcd([(c >> 12) & 0xf]);
				this.pagCountryCode += x3;
				this.pagMsg = this.pagBcd([(c >> 8) & 0xf, (c >> 4) & 0xf, c & 0xf, (d >> 12) & 0xf, (d >> 8) & 0xf, (d >> 4) & 0xf, d & 0xf]);
				this.pagExpectedPsac = 0x6;
			} else {
				this.pagMsg += this.pagBcd(nibs8);
				this.pagAssembling = false;
				this.callback({
					paging: {
						address: this.pagAddress,
						type: 'intl15',
						data: `CC:${this.pagCountryCode} ${this.pagMsg.trim()}`,
						addrFmt: this.pagAddrFmt,
					},
				});
			}
		}
	}
	private decodeOdaGroup(groupNum: number, version: number, blockB: number, bv: boolean[]): void {
		const key = (groupNum << 1) | version;
		const aid = this.odaMap.get(key);
		if (aid !== undefined) this.oda.dispatch(key, groupNum, version, blockB, bv);
	}

	// ── eRT: Enhanced RadioText (ODA AID 0x6552, IEC 62106-6) ────
	// Wire format: identical to Group 2A (4-bit segment address in block B bits[3:0],
	// A/B toggle in block B bit 4, 4 bytes per group in blocks C+D).
	// Carries up to 128 bytes of raw UTF-8, CR (0x0D) terminated.
	//
	// Approach cloned from redsea RDSString:
	//  - sequential_length_: only bytes received in-order from pos 0 count.
	//  - isComplete(): sequential fill has reached the CR terminator or pos 128.
	//  - sanitizeUtf8(): incomplete/invalid multibyte sequences replaced with '?'.
	//  - Per-codepoint quality: worst quality byte in the codepoint's byte span.
	reset(): void {
		this.pi = 0;
		this.pty = -1;
		this.tp = null;
		this.ta = null;
		this.psChars.fill(null);
		this.psStatus.fill(0);
		this.rtChars.fill(null);
		this.rtStatus.fill(0);
		this.ptynChars.fill(null);
		this.ptynStatus.fill(0);
		this.rtAbFlag = -1;
		this.rtVersion = -1;
		this.lastPs = '';
		this.lastRt = '';
		this.lastCt = '';
		this.lastPtyn = '';
		this.ecc = -1;
		this.lic = -1;
		this.afList = [];
		this.afCount = 0;
		this.afLastCount = -1;
		this.odaMap.clear();
		this.eonMap.clear();
		this.oda.reset();
		this.demod.reset();
	}

	getStatus(): RdsStatus {
		return this.demod.getStatus();
	}
}
