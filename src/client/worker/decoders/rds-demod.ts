// RDS DSP demodulator: pilot PLL, clock recovery, BCH sync, block assembly.
// Extracted from RDSDecoder to keep that file within max-lines.

import type { RdsStatus, OnGroupCallback } from './types';
import { makeBandpass, makeButterworthLpf4, type BiquadSection } from './rds-tables';

// ── DSP constants ────────────────────────────────────────────────
export const RDS_BITRATE = 1187.5;
export const RDS_PILOT = 19000;

// Offset words and syndromes (10-bit, per IEC 62106)
const OFFSET_A = 0x0fc;
const OFFSET_B = 0x198;
const OFFSET_C = 0x168;
const OFFSET_CP = 0x350;
const OFFSET_D = 0x1b4;
const RDS_POLY = 0x5b9;

function calcSyndrome(offset: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const bit = i >= 10 ? 0 : (offset >> i) & 1;
		const fb = ((reg >> 9) & 1) ^ bit;
		reg = (reg << 1) & 0x3ff;
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}
export function computeSyndrome(block: number): number {
	let reg = 0;
	for (let i = 25; i >= 0; i--) {
		const fb = ((reg >> 9) & 1) ^ ((block >> i) & 1);
		reg = (reg << 1) & 0x3ff;
		if (fb) reg ^= RDS_POLY;
	}
	return reg;
}

const SYNDROME_A = calcSyndrome(OFFSET_A);
const SYNDROME_B = calcSyndrome(OFFSET_B);
const SYNDROME_C = calcSyndrome(OFFSET_C);
const SYNDROME_CP = calcSyndrome(OFFSET_CP);
const SYNDROME_D = calcSyndrome(OFFSET_D);

function buildFecTable(offsetWord: number): Map<number, number> {
	const t = new Map<number, number>();
	for (let bit = 0; bit < 26; bit++) {
		const flipped = (((0 << 10) | offsetWord) ^ (1 << (25 - bit))) & 0x3ffffff;
		const syn = computeSyndrome(flipped);
		if (syn !== 0) t.set(syn, bit);
	}
	return t;
}
const FEC_A = buildFecTable(OFFSET_A);
const FEC_B = buildFecTable(OFFSET_B);
const FEC_C = buildFecTable(OFFSET_C);
const FEC_CP = buildFecTable(OFFSET_CP);
const FEC_D = buildFecTable(OFFSET_D);
const FEC_TABLES = [FEC_A, FEC_B, FEC_C, FEC_D];

/** RDS DSP demodulator: pilot PLL, DBPSK clock recovery, BCH block sync. */
export class RDSDemodulator {
	private phasorRe = 1;
	private phasorIm = 0;
	private readonly incRe: number;
	private readonly incIm: number;
	private readonly pilotAlpha: number;
	private readonly pilotBpf: BiquadSection;
	private pilotMixI = 0;
	private pilotMixQ = 0;
	private readonly pilotMixAlpha: number;
	private phasorCount = 0;
	private readonly bqI: BiquadSection[];
	private readonly bqQ: BiquadSection[];
	private readonly samplesPerBit: number;
	private clockPhase = 0;
	private prevBpskI = 0;
	private prevBpskQ = 0;
	private clockPowerI = 0;
	private clockPowerQ = 0;
	private clockUsesQ = false;
	private symbolIndex = 0;
	private pairEnergy = [0, 0];
	private pairParity = 0;
	private prevHalfI = 0;
	private prevHalfQ = 0;
	private prevSymI = 0;
	private prevSymQ = 0;
	private shiftReg = 0;
	private bitCount = 0;
	synced = false;
	private blockIndex = 0;
	goodBlocks = 0;
	readonly blocks: number[] = [0, 0, 0, 0];
	readonly blockValid: boolean[] = [false, false, false, false];
	readonly blockCorrected: boolean[] = [false, false, false, false];
	private blockErrors = 0;
	private nbUnsync = 0;
	private readonly BER_WINDOW = 100;
	private berHistory: Uint8Array = new Uint8Array(100).fill(1);
	private berHead = 0;
	private berSum = 100;
	private berCorrectedBlocks = 0;
	private berTotalBlocks = 0;
	private pilotPower = 0;

	constructor(
		sampleRate: number,
		private readonly onGroup: OnGroupCallback,
	) {
		const pilotFreq = (2 * Math.PI * RDS_PILOT) / sampleRate;
		this.incRe = Math.cos(pilotFreq);
		this.incIm = Math.sin(pilotFreq);
		this.pilotBpf = makeBandpass(RDS_PILOT, 30, sampleRate);
		this.pilotAlpha = (2 * Math.PI * 100) / sampleRate;
		this.pilotMixAlpha = 1 - Math.exp((-2 * Math.PI * 30) / sampleRate);
		this.samplesPerBit = sampleRate / RDS_BITRATE;
		this.bqI = makeButterworthLpf4(2400, sampleRate);
		this.bqQ = makeButterworthLpf4(2400, sampleRate);
	}

	getStatus(): RdsStatus {
		return {
			synced: this.synced,
			ber: this.berTotalBlocks === 0 ? 1 : this.berSum / this.BER_WINDOW,
			goodBlocks: this.goodBlocks,
			correctedBlocks: this.berCorrectedBlocks,
			totalBlocks: this.berTotalBlocks,
			pilotLevel: Math.sqrt(this.pilotPower),
		};
	}

	reset(): void {
		this.synced = false;
		this.blockIndex = 0;
		this.goodBlocks = 0;
		this.blockErrors = 0;
		this.nbUnsync = 0;
		this.blockValid.fill(false);
		this.blockCorrected.fill(false);
		this.bitCount = 0;
		this.shiftReg = 0;
		this.berHistory.fill(1);
		this.berHead = 0;
		this.berSum = this.BER_WINDOW;
		this.berCorrectedBlocks = 0;
		this.berTotalBlocks = 0;
		this.pilotPower = 0;
		this.phasorRe = 1;
		this.phasorIm = 0;
		this.phasorCount = 0;
		this.pilotMixI = 0;
		this.pilotMixQ = 0;
		this.clockPhase = 0;
		this.prevBpskI = 0;
		this.prevBpskQ = 0;
		this.clockPowerI = 0;
		this.clockPowerQ = 0;
		this.clockUsesQ = false;
		this.symbolIndex = 0;
		this.pairEnergy.fill(0);
		this.pairParity = 0;
		this.prevHalfI = 0;
		this.prevHalfQ = 0;
		this.prevSymI = 0;
		this.prevSymQ = 0;
		for (const bq of this.bqI) bq.reset();
		for (const bq of this.bqQ) bq.reset();
	}

	process(samples: Float32Array): void {
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i];
			const pilotBpf = this.pilotBpf.process(sample);
			const pllCos = this.phasorRe;
			const pllSin = this.phasorIm;
			this.pilotMixI += this.pilotMixAlpha * (pilotBpf * pllCos - this.pilotMixI);
			this.pilotMixQ += this.pilotMixAlpha * (pilotBpf * pllSin - this.pilotMixQ);
			const pp = this.pilotMixI * this.pilotMixI + this.pilotMixQ * this.pilotMixQ;
			this.pilotPower += 0.0001 * (pp - this.pilotPower);
			if (pp > 1e-12) {
				const corr = ((this.pilotMixI * this.pilotMixQ) / pp) * this.pilotAlpha;
				this.phasorRe += this.phasorIm * corr;
				this.phasorIm -= this.phasorRe * corr;
			}
			const newRe = this.phasorRe * this.incRe - this.phasorIm * this.incIm;
			const newIm = this.phasorRe * this.incIm + this.phasorIm * this.incRe;
			this.phasorRe = newRe;
			this.phasorIm = newIm;
			if ((++this.phasorCount & 1023) === 0) {
				const mag = 1 / Math.sqrt(this.phasorRe * this.phasorRe + this.phasorIm * this.phasorIm);
				this.phasorRe *= mag;
				this.phasorIm *= mag;
			}
			const c = pllCos;
			const s = pllSin;
			let filtI = sample * (4 * c * c * c - 3 * c);
			for (let k = 0; k < this.bqI.length; k++) filtI = this.bqI[k].process(filtI);
			let filtQ = sample * (3 * s - 4 * s * s * s);
			for (let k = 0; k < this.bqQ.length; k++) filtQ = this.bqQ[k].process(filtQ);
			this.clockPowerI += 0.001 * (filtI * filtI - this.clockPowerI);
			this.clockPowerQ += 0.001 * (filtQ * filtQ - this.clockPowerQ);
			if (this.clockPowerQ > this.clockPowerI * 2) this.clockUsesQ = true;
			else if (this.clockPowerI > this.clockPowerQ * 2) this.clockUsesQ = false;
			const timing = this.clockUsesQ ? filtQ : filtI;
			const previous = this.clockUsesQ ? this.prevBpskQ : this.prevBpskI;
			const symbolPeriod = this.samplesPerBit / 2;
			const prevPhase = this.clockPhase;
			this.clockPhase += 1;
			if (timing > 0 !== previous > 0) {
				const error = this.clockPhase > symbolPeriod / 2 ? this.clockPhase - symbolPeriod : this.clockPhase;
				this.clockPhase -= error * 0.05;
			}
			this.prevBpskI = filtI;
			this.prevBpskQ = filtQ;
			if (this.clockPhase >= symbolPeriod / 2 && prevPhase < symbolPeriod / 2) {
				const symI = this.prevHalfI - filtI;
				const symQ = this.prevHalfQ - filtQ;
				const parity = this.symbolIndex & 1;
				this.pairEnergy[parity] += symI * symI + symQ * symQ;
				if ((this.symbolIndex & 799) === 0) {
					const nextParity = this.pairEnergy[0] > this.pairEnergy[1] ? 0 : 1;
					if (nextParity !== this.pairParity) {
						this.pairParity = nextParity;
						this.prevSymI = 0;
						this.prevSymQ = 0;
					}
					this.pairEnergy.fill(0);
				}
				if (parity === this.pairParity) {
					this._processBit(symI * this.prevSymI + symQ * this.prevSymQ < 0 ? 1 : 0);
					this.prevSymI = symI;
					this.prevSymQ = symQ;
				}
				this.prevHalfI = filtI;
				this.prevHalfQ = filtQ;
				this.symbolIndex++;
			}
			if (this.clockPhase >= symbolPeriod) this.clockPhase -= symbolPeriod;
		}
	}

	blockQuality(idx: number): number {
		if (!this.blockValid[idx]) return 2;
		return this.blockCorrected[idx] ? 1 : 0;
	}

	/** Feed a single biphase bit directly (for testing without MPX signal generation). */
	processBit(bit: number): void {
		this._processBit(bit);
	}

	private _processBit(bit: number): void {
		this.shiftReg = ((this.shiftReg << 1) | bit) & 0x3ffffff;
		this.bitCount++;
		if (!this.synced) {
			if (this.bitCount >= 26) {
				const syn = computeSyndrome(this.shiftReg);
				const index = [SYNDROME_A, SYNDROME_B, SYNDROME_C, SYNDROME_D].indexOf(syn);
				const position = syn === SYNDROME_CP ? 2 : index;
				if (position !== -1) {
					this.synced = true;
					this.goodBlocks = 1;
					this.blockErrors = 0;
					this.blockValid.fill(false);
					this.blocks[position] = (this.shiftReg >> 10) & 0xffff;
					this.blockValid[position] = true;
					this.blockIndex = (position + 1) & 3;
					this.bitCount = 0;
				}
			}
			return;
		}
		if (this.bitCount < 26) return;
		this.bitCount = 0;
		if (this.blockIndex === 0) {
			this.goodBlocks = 0;
			this.blockValid.fill(false);
		}
		const syn = computeSyndrome(this.shiftReg);
		const expectedSyn = [SYNDROME_A, SYNDROME_B, SYNDROME_C, SYNDROME_D][this.blockIndex];
		const isValid = syn === expectedSyn || (this.blockIndex === 2 && syn === SYNDROME_CP);
		this.berTotalBlocks++;
		if (isValid) {
			this.blocks[this.blockIndex] = (this.shiftReg >> 10) & 0xffff;
			this.blockValid[this.blockIndex] = true;
			this.blockCorrected[this.blockIndex] = false;
			this.goodBlocks++;
			this.blockErrors = 0;
			this.berSum -= this.berHistory[this.berHead];
			this.berHistory[this.berHead] = 0;
			this.berHead = (this.berHead + 1) % this.BER_WINDOW;
		} else {
			const fecTable =
				this.blockIndex === 2 && syn !== expectedSyn
					? FEC_TABLES[this.blockIndex].get(syn) !== undefined
						? FEC_TABLES[this.blockIndex]
						: FEC_CP
					: FEC_TABLES[this.blockIndex];
			const errBit = fecTable.get(syn);
			if (errBit !== undefined) {
				const corrected = (this.shiftReg ^ (1 << (25 - errBit))) & 0x3ffffff;
				this.blocks[this.blockIndex] = (corrected >> 10) & 0xffff;
				this.blockValid[this.blockIndex] = true;
				this.blockCorrected[this.blockIndex] = true;
				this.goodBlocks++;
				this.blockErrors = 0;
				this.berCorrectedBlocks++;
				this.berSum -= this.berHistory[this.berHead];
				this.berHistory[this.berHead] = 0;
				this.berHead = (this.berHead + 1) % this.BER_WINDOW;
			} else {
				this.blockValid[this.blockIndex] = false;
				this.berSum -= this.berHistory[this.berHead];
				this.berHistory[this.berHead] = 1;
				this.berHead = (this.berHead + 1) % this.BER_WINDOW;
				this.berSum++;
				if (++this.blockErrors >= 16) {
					this.synced = false;
					this.goodBlocks = 0;
					this.blockErrors = 0;
					return;
				}
			}
		}
		this.blockIndex = (this.blockIndex + 1) & 3;
		if (this.blockIndex === 0 && this.goodBlocks >= 2) this.onGroup(this.blocks, this.blockValid, this.blockCorrected);
		if (this.blockIndex === 0) {
			if (this.goodBlocks === 0) {
				if (++this.nbUnsync >= 4) {
					this.synced = false;
					this.nbUnsync = 0;
				}
			} else {
				this.nbUnsync = 0;
			}
			this.goodBlocks = 0;
			this.blockValid.fill(false);
			this.blockErrors = 0;
		}
	}
}
