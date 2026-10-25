/*
LimeSDR USB WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on LimeSuite (Apache 2.0) https://github.com/myriadrf/LimeSuite

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
	Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
	Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the
	documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import {
	REF_CLK,
	CGEN_VCO_MIN,
	CGEN_VCO_MAX,
	SX_VCO_MIN,
	SX_VCO_MAX,
	SX_VCO_RANGES,
	SX_DIV2_THRESHOLD,
	REG_RESET,
	REG_LML_CONF1,
	REG_LML1_MAP,
	REG_CLK_MUX,
	REG_CLK_SRC,
	REG_CGEN_CFG,
	REG_CGEN_FRAC_L,
	REG_CGEN_INT,
	REG_CGEN_DIV,
	REG_CGEN_CSW,
	REG_CGEN_CMP,
	REG_SX_CFG,
	REG_SX_FRAC_L,
	REG_SX_INT,
	REG_SX_DIV,
	REG_SX_ICT,
	REG_SX_VCO,
	REG_SX_CMP,
	REG_RXTSP_CFG,
	REG_RXTSP_DEC,
	REG_RXTSP_AGC,
	REG_RXTSP_BYP,
	FPGA_REG_DIRECT_CLK,
	FPGA_REG_CH_EN,
	FPGA_REG_IFACE,
	FPGA_REG_CTRL,
	FPGA_REG_MODE,
	FPGA_REG_MN_ODD,
	FPGA_REG_C_ODD0,
	FPGA_REG_N_CNT,
	FPGA_REG_M_CNT,
	FPGA_REG_C0_CNT,
	FPGA_REG_CHIP_SEL,
	delay,
	setBits,
	getBits,
} from './protocol';
import { LimeSDRTransport } from './transport';

export abstract class LimeSDRClocks extends LimeSDRTransport {
	protected rxOversample = 2;
	protected sxLockWidth = 0;
	protected sxReady = false;
	// ── CGEN PLL (Clock Generator) ──────────────────────────────

	async setCGENFrequency(freq_Hz: number): Promise<void> {
		await this.modifyReg(REG_CGEN_CFG, 11, 11, 0);
		await this.modifyReg(REG_CGEN_DIV, 12, 11, 2);

		// Calculate output divider so VCO lands in valid range
		const iHdiv_high = Math.floor(CGEN_VCO_MAX / 2 / freq_Hz) - 1;
		const iHdiv_low = Math.ceil(CGEN_VCO_MIN / 2 / freq_Hz);
		let iHdiv = Math.floor((iHdiv_low + iHdiv_high) / 2);
		iHdiv = Math.max(0, Math.min(255, iHdiv));

		const vcoFreq = 2 * (iHdiv + 1) * freq_Hz;
		if (vcoFreq < CGEN_VCO_MIN || vcoFreq > CGEN_VCO_MAX) {
			throw new Error(`CGEN: VCO freq ${(vcoFreq / 1e6).toFixed(1)} MHz out of range`);
		}

		const ratio = vcoFreq / REF_CLK;
		// Round the whole fixed-point divider so a fractional rollover carries
		// into INT instead of silently dropping one reference-clock period.
		const dividerWord = Math.round(ratio * (1 << 20));
		const gINT = Math.floor(dividerWord / (1 << 20)) - 1;
		const gFRAC = dividerWord & 0xfffff;

		// Write CGEN PLL registers
		await this.writeLMS7002Batch([
			[REG_CGEN_FRAC_L, gFRAC & 0xffff],
			[REG_CGEN_INT, ((gINT & 0x3ff) << 4) | ((gFRAC >> 16) & 0xf)],
			[REG_CGEN_DIV, setBits(await this.readLMS7002(REG_CGEN_DIV), 10, 3, iHdiv)],
		]);

		// Enable VCO
		await this.modifyReg(REG_CGEN_CFG, 2, 1, 0); // PD_VCO=0, PD_VCO_COMP=0

		// Tune VCO
		const locked = await this.tuneVCO('CGEN');
		if (locked) {
			console.log(`LimeSDR: CGEN locked, VCO=${(vcoFreq / 1e6).toFixed(1)} MHz, DIV=${iHdiv}, INT=${gINT}, FRAC=${gFRAC}`);
		} else {
			throw new Error('LimeSDR: CGEN VCO failed to lock');
		}
	}

	// ── SX PLL (LO Synthesizer) ─────────────────────────────────

	async setFrequencySXR(freq_Hz: number, unstableBand = -1): Promise<void> {
		this.sxReady = false;
		try {
			await this.programFrequencySXR(freq_Hz, unstableBand);
			this.sxReady = true;
		} finally {
			await this.modifyReg(REG_RESET, 1, 0, this.rxChannel + 1);
		}
	}

	protected async programFrequencySXR(freq_Hz: number, unstableBand: number): Promise<void> {
		await this.modifyReg(REG_RESET, 1, 0, 1);

		// Find output divider
		let div_loch = -1;
		let vcoFreq = 0;
		for (let d = 6; d >= 0; d--) {
			const testVCO = (1 << (d + 1)) * freq_Hz;
			if (testVCO >= SX_VCO_MIN && testVCO <= SX_VCO_MAX) {
				div_loch = d;
				vcoFreq = testVCO;
				break;
			}
		}
		if (div_loch < 0) throw new Error(`SX: cannot tune to ${(freq_Hz / 1e6).toFixed(3)} MHz`);

		// Calculate PLL values
		const en_div2 = vcoFreq > SX_DIV2_THRESHOLD ? 1 : 0;
		const divisor = en_div2 ? 2 : 1;
		const ratio = vcoFreq / (REF_CLK * divisor);
		const dividerWord = Math.round(ratio * (1 << 20));
		const intPart = Math.floor(dividerWord / (1 << 20)) - 4;
		const fracPart = dividerWord & 0xfffff;

		// Write SX PLL registers
		let sxCfg = await this.readLMS7002(REG_SX_CFG);
		sxCfg = setBits(sxCfg, 10, 10, en_div2); // EN_DIV2_DIVPROG
		sxCfg = setBits(sxCfg, 9, 9, 0); // EN_INTONLY=0 (fractional mode)
		sxCfg = setBits(sxCfg, 2, 1, 0); // PD_VCO=0, PD_VCO_COMP=0
		sxCfg = setBits(sxCfg, 0, 0, 1); // EN_G=1
		await this.writeLMS7002(REG_SX_CFG, sxCfg);

		await this.writeLMS7002(REG_SX_FRAC_L, fracPart & 0xffff);
		let intReg = await this.readLMS7002(REG_SX_INT);
		intReg = setBits(intReg, 13, 4, intPart & 0x3ff);
		intReg = setBits(intReg, 3, 0, (fracPart >> 16) & 0xf);
		await this.writeLMS7002(REG_SX_INT, intReg);

		let divReg = await this.readLMS7002(REG_SX_DIV);
		divReg = setBits(divReg, 8, 6, div_loch & 0x7);
		await this.writeLMS7002(REG_SX_DIV, divReg);

		// Search all bands at each bias, then verify the restored candidate. A band
		// can lock during the search but need retuning after visiting another band.
		// LimeSuite allows up to five attempts with increasing VCO bias current.
		let bestVCO = -1;
		let bestCSW = -1;
		let foundLock = false;
		for (let attempt = 0; attempt < 5; attempt++) {
			const candidates = await this.findSXCandidates(vcoFreq);
			foundLock ||= candidates.length > 0;
			// Margin from the comparator boundaries matters more than proximity to
			// nominal CSW=128. A one-code lock can disappear as streaming starts.
			candidates.sort(
				(a, b) =>
					Number(a.band === unstableBand) - Number(b.band === unstableBand) ||
					b.width - a.width ||
					Math.abs(a.csw - 128) - Math.abs(b.csw - 128),
			);
			for (const candidate of candidates) {
				if (await this.restoreSXBand(candidate.band, candidate.csw, freq_Hz)) {
					bestVCO = candidate.band;
					bestCSW = getBits(await this.readLMS7002(REG_SX_VCO), 10, 3);
					break;
				}
			}
			if (bestVCO >= 0) break;
			const ict = getBits(await this.readLMS7002(REG_SX_ICT), 7, 0);
			if (attempt === 4 || ict === 255) break;
			await this.modifyReg(REG_SX_ICT, 7, 0, Math.min(255, ict + 32));
		}
		if (bestVCO < 0) {
			throw new Error(`LimeSDR: SX VCO ${foundLock ? 'lost lock' : 'failed to lock'} at ${(freq_Hz / 1e6).toFixed(3)} MHz`);
		}

		// Readback verifies the divider programming; the comparator above verifies lock.
		const rbInt = getBits(await this.readLMS7002(REG_SX_INT), 13, 4);
		const rbFracL = await this.readLMS7002(REG_SX_FRAC_L);
		const rbFracH = getBits(await this.readLMS7002(REG_SX_INT), 3, 0);
		const rbDiv = getBits(await this.readLMS7002(REG_SX_DIV), 8, 6);
		const rbEnDiv2 = getBits(await this.readLMS7002(REG_SX_CFG), 10, 10);
		const rbFrac = (rbFracH << 16) | rbFracL;
		const rbDivisor = rbEnDiv2 ? 2 : 1;
		const rbVCO = (rbInt + 4 + rbFrac / (1 << 20)) * REF_CLK * rbDivisor;
		const rbFreq = rbVCO / (1 << (rbDiv + 1));
		const frequencyStep = (REF_CLK * divisor) / (1 << (div_loch + 1)) / (1 << 20);
		if (Math.abs(rbFreq - freq_Hz) > frequencyStep / 2 + 0.001) {
			throw new Error(
				`LimeSDR: SXR frequency readback mismatch: requested ${(freq_Hz / 1e6).toFixed(6)} MHz, read ${(rbFreq / 1e6).toFixed(6)} MHz`,
			);
		}
		console.log(
			`LimeSDR: SXR locked at ${(freq_Hz / 1e6).toFixed(3)} MHz, actual=${(rbFreq / 1e6).toFixed(3)} MHz, VCO=${bestVCO}, CSW=${bestCSW}, div_loch=${div_loch}, INT=${rbInt}, FRAC=${rbFrac}, DIV=${rbDiv}, EN_DIV2=${rbEnDiv2}, CFG=0x${(await this.readLMS7002(REG_SX_CFG)).toString(16)}`,
		);

		this.currentFrequency = freq_Hz;
	}

	private async findSXCandidates(vcoFrequency: number): Promise<Array<{ band: number; csw: number; width: number }>> {
		const candidates: Array<{ band: number; csw: number; width: number }> = [];
		for (let band = 0; band < SX_VCO_RANGES.length; band++) {
			const [minimum, maximum] = SX_VCO_RANGES[band];
			// Comparator windows can appear even when this oscillator cannot
			// reach the programmed target. Do not rank those as usable locks.
			if (vcoFrequency < minimum || vcoFrequency > maximum) continue;
			await this.modifyReg(REG_SX_VCO, 2, 1, band);
			if (await this.tuneVCO('SX')) {
				candidates.push({ band, csw: getBits(this.regCache.get(REG_SX_VCO) ?? 0, 10, 3), width: this.sxLockWidth });
			}
		}
		return candidates;
	}

	protected async restoreSXBand(band: number, csw: number, freq_Hz: number): Promise<boolean> {
		let vcoReg = await this.readLMS7002(REG_SX_VCO);
		vcoReg = setBits(vcoReg, 2, 1, band);
		vcoReg = setBits(vcoReg, 10, 3, csw);
		await this.writeLMS7002(REG_SX_VCO, vcoReg);
		if (await this.waitForSXLock()) return true;
		console.warn(`LimeSDR: SXR band ${band} lost lock after restore; retuning at ${(freq_Hz / 1e6).toFixed(3)} MHz`);
		return (await this.tuneVCO('SX')) && (await this.waitForSXLock());
	}

	protected async waitForSXLock(): Promise<boolean> {
		// Require consecutive hardware comparator readings, allowing brief settling
		// after a band change without accepting a transient lock indication.
		let consecutive = 0;
		for (let sample = 0; sample < 10; sample++) {
			await delay(1);
			consecutive = getBits(await this.readLMS7002(REG_SX_CMP), 13, 12) === 2 ? consecutive + 1 : 0;
			if (consecutive === 3) {
				// Live retunes can report lock for hundreds of ms, then intermittently
				// unlock with the divider words unchanged. Observe a full second.
				for (let hold = 0; hold < 20; hold++) {
					await delay(50);
					if (getBits(await this.readLMS7002(REG_SX_CMP), 13, 12) !== 2) return false;
				}
				return true;
			}
		}
		return false;
	}

	// ── VCO Tuning (Binary Search for CSW) ──────────────────────

	protected async tuneVCO(module: 'CGEN' | 'SX'): Promise<boolean> {
		const isCGEN = module === 'CGEN';
		if (!isCGEN) this.sxLockWidth = 0;
		const addrCSW = isCGEN ? REG_CGEN_CSW : REG_SX_VCO;
		const addrCMP = isCGEN ? REG_CGEN_CMP : REG_SX_CMP;
		const cswMSB = isCGEN ? 8 : 10;
		const cswLSB = isCGEN ? 1 : 3;

		const checkCSW = async (csw: number): Promise<number> => {
			await this.modifyReg(addrCSW, cswMSB, cswLSB, csw);
			await delay(1);
			return getBits(await this.readLMS7002(addrCMP), 13, 12);
		};
		if (!isCGEN && !(await this.sxEndpointsBracketTarget(checkCSW))) return false;

		// Comparator 0 = too low, 2 = locked, 3 = too high. Find both
		// boundaries so we tune to the middle rather than the unstable upper edge.
		// SX's capacitor bank can have a discontinuity at 128 (LimeSuite TuneVCO).
		const ranges = isCGEN
			? [[0, 255]]
			: [
					[0, 127],
					[128, 255],
				];
		const locks: Array<[number, number]> = [];
		for (const [start, end] of ranges) {
			let low = start;
			let high = end;
			while (low < high) {
				const mid = Math.floor((low + high) / 2);
				if ((await checkCSW(mid)) === 0) low = mid + 1;
				else high = mid;
			}
			if ((await checkCSW(low)) !== 2) continue;
			const first = low;
			high = end;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if ((await checkCSW(mid)) === 2) low = mid;
				else high = mid - 1;
			}
			locks.push([first, low]);
		}
		if (locks.length === 0) return false;
		if (locks.length === 2 && locks[0][1] + 1 === locks[1][0]) locks.splice(0, 2, [locks[0][0], locks[1][1]]);
		const [low, high] = locks.reduce((best, range) => (range[1] - range[0] > best[1] - best[0] ? range : best));
		const locked = (await checkCSW(Math.floor((low + high) / 2))) === 2;
		if (locked && !isCGEN) this.sxLockWidth = high - low + 1;
		return locked;
	}

	private async sxEndpointsBracketTarget(checkCSW: (csw: number) => Promise<number>): Promise<boolean> {
		// LimeSuite rejects a band whose endpoint comparators cannot bracket
		// the target before searching either half of the capacitor bank.
		return (await checkCSW(0)) !== 3 && (await checkCSW(255)) !== 0;
	}

	// ── Interface Rate Configuration ────────────────────────────
	// Matches LimeSuite's SetRate + SetInterfaceFrequency logic

	// ── RxTSP Configuration ─────────────────────────────────────

	protected async configureRxTSP(): Promise<void> {
		// Enable RxTSP
		await this.modifyReg(REG_RXTSP_CFG, 0, 0, 1);

		const decimation = Math.log2(this.rxOversample) - 1;
		await this.modifyReg(REG_RXTSP_DEC, 14, 12, decimation);
		await this.modifyReg(0x0203, 14, 12, decimation);

		// AGC bypass
		await this.modifyReg(REG_RXTSP_AGC, 13, 12, 2);

		// Bypass register 0x040C:
		// All TSP blocks bypassed except DC correction (bit 2 = 0)
		// Bit 7: CMIX_BYP=1 (bypass NCO — no digital frequency shift)
		// Bit 6: AGC_BYP=1, Bits 5-3: GFIR3/2/1_BYP=1
		// Bit 1: GC_BYP=1, Bit 0: PH_BYP=1 (no calibration data available)
		await this.writeLMS7002(REG_RXTSP_BYP, 0x00fb);

		await this.writeLMS7002(0x0440, 0); // NCO mode/selection
		await this.writeLMS7002(0x0441, 0); // Phase offset
		await this.writeLMS7002(0x0442, 0); // FCW0 [31:16]
		await this.writeLMS7002(0x0443, 0); // FCW0 [15:0]

		// DC correction averaging (register 0x0404 bits [2:0] per LimeSuite)
		await this.modifyReg(0x0404, 2, 0, 7); // Max averaging window

		// Set IQ correction defaults (unity gain, zero phase)
		await this.writeLMS7002(0x0401, 2047); // GCORRQ = 2047 (unity)
		await this.writeLMS7002(0x0402, 2047); // GCORRI = 2047 (unity)
		await this.modifyReg(REG_RXTSP_DEC, 11, 0, 0); // IQCORR = 0 (no phase correction)
	}

	// ── LML Interface Configuration ─────────────────────────────

	protected async configureLML(): Promise<void> {
		// 0x0021: Pad pull-ups and SPI mode (4-wire)
		await this.writeLMS7002(0x0021, 0x0e9f);

		await this.writeLMS7002(0x0022, 0x0fff);

		// 0x0023: LML direction/mode/routing (LimeSuite Init default)
		await this.writeLMS7002(REG_LML_CONF1, 0x5550);

		// 0x0024, 0x0027: Sample position mapping (AI=0, AQ=1, BI=2, BQ=3)
		await this.writeLMS7002(REG_LML1_MAP, 0xe4e4);
		await this.writeLMS7002(0x0027, 0xe4e4);

		await this.writeLMS7002(0x002c, 0x0000);

		await this.writeLMS7002(REG_CLK_MUX, 0x0086);

		// 0x002B: MCLK sources (LimeSuite Init default)
		// MCLK1SRC[3:2]=2 (TXTSPCLKA_DIV), MCLK2SRC[5:4]=3 (RXTSPCLKA_DIV)
		await this.writeLMS7002(REG_CLK_SRC, 0x0038);

		// LimeSuite SetInterfaceFrequency: preserve 2 * outputRate MCLKs in MIMO.
		const decimation = Math.log2(this.rxOversample) - 1;
		if (decimation > 0) {
			const divider = 2 ** decimation / 2 - 1;
			await this.writeLMS7002(0x002c, (divider << 8) | divider);
			await this.modifyReg(REG_CLK_SRC, 5, 4, 1);
			await this.modifyReg(REG_CLK_SRC, 3, 2, 0);
			await this.modifyReg(REG_CLK_SRC, 1, 0, 3);
		}
	}

	// ── FPGA Configuration ──────────────────────────────────────

	protected async configureFPGA(): Promise<void> {
		// Select FPGA chip
		await this.writeFPGA(FPGA_REG_CHIP_SEL, 1);

		// Stop any existing streaming
		await this.writeFPGA(FPGA_REG_CTRL, 0x0000);

		await this.writeFPGA(FPGA_REG_IFACE, 0x0100);

		await this.writeFPGA(FPGA_REG_CH_EN, 1 << this.rxChannel);

		// Configure FPGA PLL for RX
		await this.configureFPGAPLL();

		console.log(`LimeSDR: FPGA configured (MIMO mode, RX${this.rxChannel + 1})`);
	}

	protected async configureFPGAPLL(): Promise<void> {
		const pllInputFreq = this.currentSampleRate * 2;
		const pllOutputFreq = pllInputFreq;

		const rxPhase = 89.46 + 1.24e-6 * pllInputFreq;
		const txPhase = 89.61 + 2.71e-7 * pllInputFreq;

		// Configure TX PLL (index 0) then RX PLL (index 1)
		await this.programFPGAPLL(0, pllInputFreq, [pllOutputFreq, pllOutputFreq], [0, txPhase]);
		await this.programFPGAPLL(1, pllInputFreq, [pllOutputFreq, pllOutputFreq], [0, rxPhase]);
		if (pllInputFreq >= 5e6) {
			const board = await this.readFPGA(0x0000);
			const version = ((await this.readFPGA(0x0001)) << 8) | (await this.readFPGA(0x0002));
			if (board === 0x000e && version > 0x020e) await this.alignRXClock(pllInputFreq, pllOutputFreq);
		}
		await this.resetLogicRegisters();
	}

	protected async alignRXClock(inputFreq: number, outputFreq: number): Promise<void> {
		const addresses = [0x0021, 0x0022, 0x0023, 0x0024, 0x0027, 0x002a, 0x0082, 0x0400, 0x040c, 0x040b];
		const backup: Array<[number, number]> = [];
		const backupB: Array<[number, number]> = [];
		const originalReset = await this.readLMS7002(REG_RESET);
		try {
			await this.writeLMS7002(REG_RESET, 0xfffd);
			for (const address of addresses) backup.push([address, await this.readLMS7002(address)]);
			await this.writeLMS7002(REG_RESET, 0xfffe);
			for (const address of addresses.filter((address) => address >= 0x0100)) backupB.push([address, await this.readLMS7002(address)]);
			await this.writeLMS7002(REG_RESET, 0xffff);
			await this.writeLMS7002Batch([
				[0x0021, 0x0e9f],
				[0x0022, 0x0fff],
				[0x0023, 0x5550],
				[0x0024, 0xe4e4],
				[0x0027, 0xe4e4],
				[0x002a, 0x0086],
				[0x0082, 0x8001],
				[0x0400, 0x028d],
				[0x040c, 0x00ff],
				[0x040b, 0x5555],
				[0x0400, 0x02cd],
				[0x040b, 0xaaaa],
				[0x0400, 0x02ed],
			]);
			await this.programFPGAPLL(1, inputFreq, [outputFreq, outputFreq], [], true);
			console.log('LimeSDR: RX interface phase search passed');
		} finally {
			try {
				await this.writeLMS7002(REG_RESET, 0xfffe);
				await this.writeLMS7002Batch(backupB);
				await this.writeLMS7002(REG_RESET, 0xfffd);
				await this.writeLMS7002Batch(backup);
			} finally {
				await this.writeLMS7002(REG_RESET, originalReset);
			}
		}
	}

	protected async programFPGAPLL(
		pllIndex: number,
		inputFreq: number,
		clockFreqs: number[],
		clockPhases: number[] = [],
		findPhase = false,
	): Promise<void> {
		if (inputFreq < 5e6) {
			const directClk = await this.readFPGA(FPGA_REG_DIRECT_CLK);
			await this.writeFPGA(FPGA_REG_DIRECT_CLK, directClk | (1 << pllIndex));
			return;
		}

		const VCO_MIN = 600e6;
		const VCO_MAX = 1300e6;
		const PLL_READ_ADDR = 0x0003;
		const PLL_WRITE_ADDR = 0x0023;

		// Disable direct clock bypass for this PLL
		const directClk = await this.readFPGA(FPGA_REG_DIRECT_CLK);
		await this.writeFPGA(FPGA_REG_DIRECT_CLK, directClk & ~(1 << pllIndex));

		// Read control reg from 0x0003, write to 0x0023 (different addresses!)
		let reg23val = await this.readFPGA(PLL_READ_ADDR);
		reg23val &= ~(0x1f << 3); // Clear PLL index
		reg23val &= ~0x07; // Clear start/reset bits
		reg23val |= pllIndex << 3;

		// Enable phase config
		const reg25 = await this.readFPGA(FPGA_REG_MODE);
		await this.writeFPGA(FPGA_REG_MODE, reg25 | 0x80);
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val);

		// Reset PLL
		if (!findPhase) {
			await this.writeFPGA(PLL_WRITE_ADDR, reg23val | 0x04);
			await delay(10);
			await this.writeFPGA(PLL_WRITE_ADDR, reg23val & ~0x04);
			await delay(10);
		}

		// Find best M, N for VCO
		const { bestM, bestN } = findPllDividers(inputFreq, VCO_MIN, VCO_MAX, clockFreqs);

		const Fvco = (inputFreq * bestM) / bestN;

		// Program M/N counters
		const mLow = Math.floor(bestM / 2);
		const mHigh = mLow + (bestM % 2);
		const nLow = Math.floor(bestN / 2);
		const nHigh = nLow + (bestN % 2);

		let mnOddByp = ((bestM % 2) << 3) | ((bestN % 2) << 1);
		if (bestM === 1) mnOddByp |= 1 << 2;
		if (bestN === 1) mnOddByp |= 1;

		await this.writeFPGA(FPGA_REG_MN_ODD, mnOddByp);
		await this.writeFPGA(FPGA_REG_N_CNT, (nHigh << 8) | nLow);
		await this.writeFPGA(FPGA_REG_M_CNT, (mHigh << 8) | mLow);

		// Program C counters and bypass flags
		let c7c0Byp = 0x5555; // All bypassed by default
		for (let i = 0; i < clockFreqs.length && i < 8; i++) {
			const C = Math.round(Fvco / clockFreqs[i]);
			const cLow = Math.floor(C / 2);
			const cHigh = cLow + (C % 2);
			if (C !== 1) c7c0Byp &= ~(1 << (i * 2)); // Clear bypass
			c7c0Byp |= (C % 2) << (i * 2 + 1); // Set odd bit
			await this.writeFPGA(FPGA_REG_C0_CNT + i, (cHigh << 8) | cLow);
		}
		await this.writeFPGA(FPGA_REG_C_ODD0, c7c0Byp);
		await this.writeFPGA(0x0028, 0x5555); // C[15:8] all bypassed

		// Start PLL configuration
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val | 0x01);
		await delay(20);
		await this.writeFPGA(PLL_WRITE_ADDR, reg23val & ~0x01);
		if (findPhase) {
			const divider = Math.round(Fvco / clockFreqs[1]);
			const phaseControl = (reg23val & ~0x4707) | 0x6300;
			await this.writeFPGA(PLL_WRITE_ADDR, phaseControl);
			await this.writeFPGA(0x0024, 8 * divider - 1);
			await this.writeFPGA(PLL_WRITE_ADDR, phaseControl | 0x02);
			try {
				const deadline = Date.now() + 3000;
				while (Date.now() < deadline) {
					const status = await this.readFPGA(0x0021);
					if (status & 0x04) {
						if (status & 0x08) throw new Error('LimeSDR: RX interface phase search failed');
						return;
					}
					await delay(10);
				}
				throw new Error('LimeSDR: RX interface phase search timed out');
			} finally {
				await this.writeFPGA(PLL_WRITE_ADDR, phaseControl & ~0x02);
			}
		}

		// Phase shifts for clock outputs
		for (let i = 0; i < clockPhases.length; i++) {
			const phase = clockPhases[i];
			if (!phase) continue;
			const C = Math.round(Fvco / clockFreqs[i]);
			const stepDeg = 360.0 / (8.0 * C);
			const nSteps = Math.round(phase / stepDeg);
			if (nSteps === 0) continue;

			const cntInd = (i + 2) & 0x1f;
			let phReg = reg23val & ~0x07; // Clear start bits
			phReg &= ~(0xf << 8); // Clear CNT_IND
			phReg |= cntInd << 8;
			if (nSteps > 0) phReg |= 1 << 13; // PHCFG_UPDN

			await this.writeFPGA(PLL_WRITE_ADDR, phReg & ~0x02);
			await this.writeFPGA(0x0024, Math.abs(nSteps)); // Phase count
			await this.writeFPGA(PLL_WRITE_ADDR, phReg);
			await this.writeFPGA(PLL_WRITE_ADDR, phReg | 0x02); // PHCFG_START
			await delay(10);
			await this.writeFPGA(PLL_WRITE_ADDR, phReg & ~0x02);
		}

		console.log(`LimeSDR: FPGA PLL ${pllIndex} configured (M=${bestM}, VCO=${(Fvco / 1e6).toFixed(0)} MHz)`);
	}
}

function findPllDividers(inputFreq: number, VCO_MIN: number, VCO_MAX: number, clockFreqs: number[]) {
	let bestM = 1,
		bestN = 1,
		bestDev = 1e18;
	for (let m = 1; m <= 255; m++) {
		const vco = inputFreq * m;
		if (vco < VCO_MIN || vco > VCO_MAX) continue;
		let dev = 0;
		let valid = true;
		for (const f of clockFreqs) {
			const c = Math.round(vco / f);
			if (c < 1 || c > 255) {
				valid = false;
				break;
			}
			dev += Math.abs(vco / c - f);
		}
		if (!valid) continue;
		if (dev < bestDev) {
			bestDev = dev;
			bestM = m;
			bestN = 1;
		}
		if (dev === 0) break;
	}
	return { bestM, bestN };
}
