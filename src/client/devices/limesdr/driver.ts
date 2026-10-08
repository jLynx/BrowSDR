import { errorMessage } from '@/platform/errors';
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
	CMD_LMS7002_RST,
	EP_STREAM_IN_NUM,
	TRANSFER_SIZE,
	STREAM_PKT_SIZE,
	STREAM_HDR_SIZE,
	STREAM_PAYLOAD,
	NUM_TRANSFERS,
	STREAM_START_TIMEOUT_MS,
	STREAM_STOP_TIMEOUT_MS,
	MAX_SAMPLE_RATE,
	REG_RESET,
	REG_LML_CONF1,
	REG_LML1_MAP,
	REG_CLK_MUX,
	REG_CLK_SRC,
	REG_AFE_CFG,
	REG_CGEN_CFG,
	REG_CGEN_DIV,
	REG_RFE_EN,
	REG_RFE_PATH,
	REG_RFE_GAIN,
	REG_RBB_PGA,
	REG_RBB_EN,
	REG_RXTSP_CFG,
	REG_RXTSP_DEC,
	REG_RXTSP_BYP,
	REG_TXTSP_CFG,
	FPGA_REG_DIRECT_CLK,
	FPGA_REG_CH_EN,
	FPGA_REG_IFACE,
	FPGA_REG_TSTAMP,
	FPGA_REG_CTRL,
	FPGA_REG_CHIP_SEL,
	delay,
	setBits,
	getBits,
	lnaGainToReg,
} from './protocol';
import { LimeRxLevel } from './rx-level';
import { LimeSDRClocks } from './clocks';

export class LimeSDR extends LimeSDRClocks {
	readonly rxLevel = new LimeRxLevel();

	override async close(): Promise<void> {
		if (this.rxRunning) await this.stopStreaming();
		try {
			await this.dev.close();
		} catch (_) {
			/* ignore */
		}
	}

	// ── Initialization ──────────────────────────────────────────

	async initialize(): Promise<void> {
		console.log('LimeSDR: starting initialization...');

		// 1. Hardware reset via LMS64C command
		const rstData = new Uint8Array(1);
		rstData[0] = 2; // pulse reset
		await this.sendCommand(CMD_LMS7002_RST, rstData);
		this.regCache.clear();
		await delay(50);

		// 2. Software reset sequence (LimeSuite ResetChip pattern)
		// Assert all resets (LRST/MRST active-low = 0 means in reset)
		await this.writeLMS7002(REG_RESET, 0x0000);
		await delay(10);
		// Release all resets (LRST/MRST = 1 = normal, SRST = 1 = asserted)
		await this.writeLMS7002(REG_RESET, 0xffff);
		await delay(10);

		await delay(5);
		console.log('LimeSDR: chip reset complete');

		await this.writeLMS7002(REG_AFE_CFG, 0x8001);
		await this.modifyReg(0x0081, 0, 0, 1);
		await this.writeLMS7002Batch([
			[0x002d, 0x0641],
			[0x00a6, 0x000f],
			[0x010c, 0x8865],
			[0x010d, 0x011a],
			[0x010e, 0x0000],
			[0x010f, 0x3142],
			[0x0110, 0x2b14],
			[0x0111, 0x0000],
			[0x0112, 0x000c],
			[0x0113, 0x03c2],
			[0x0114, 0x01f0],
			[0x0115, 0x000d],
			[0x0118, 0x418c],
			[0x0119, 0x5292],
			[0x011a, 0x3001],
			[0x0400, 0x8081],
			[0x0404, 0x0006],
			[0x040b, 0x1020],
		]);
		await this.modifyReg(0x0124, 4, 2, 7);

		// 5. Enable CGEN and configure for default sample rate
		await this.modifyReg(REG_CGEN_CFG, 0, 0, 1); // EN_G_CGEN = 1
		console.log(`LimeSDR: setting CGEN for ${(this.currentSampleRate / 1e6).toFixed(2)} MS/s...`);
		await this.setCGENFrequency(this.currentSampleRate * 8);

		// Set analog bandwidth
		await this.setAnalogBandwidth(this.currentSampleRate);

		// 6. Enable RFE (RX front-end) — power on ALL blocks
		await this.modifyReg(REG_RFE_EN, 0, 0, 1); // EN_G_RFE = 1
		// Clear all power-down bits [7:1]:
		// PD_LNA[7]=0, PD_RLOOPB_1[6]=0, PD_RLOOPB_2[5]=0,
		// PD_MXLOBUF[4]=0, PD_QGEN[3]=0, PD_RSSI[2]=0, PD_TIA_RFE[1]=0
		await this.modifyReg(REG_RFE_EN, 7, 1, 0);
		await this.modifyReg(REG_RFE_EN, 6, 5, 3);
		// Set antenna path
		await this.setAntennaPath(1); // LNAL default

		// 7. Set default gains
		await this.setLNAGain(14);
		await this.setTIAGain(2); // 12 dB
		await this.setPGAGain(16); // +4 dB

		await this.modifyReg(REG_RBB_EN, 0, 0, 1); // EN_G_RBB = 1
		await this.modifyReg(REG_RBB_EN, 1, 1, 0);

		// 8b. Configure RxTSP
		await this.configureRxTSP();

		// 8c. Enable TxTSP (needed for clock routing)
		await this.modifyReg(REG_TXTSP_CFG, 0, 0, 1);

		// 8d. Configure LML interface
		await this.configureLML();

		// 8e. Configure FPGA
		await this.configureFPGA();

		// 9. Configure and tune SXR (RX LO synthesizer)
		console.log(`LimeSDR: tuning SXR to ${(this.currentFrequency / 1e6).toFixed(3)} MHz...`);
		await this.setFrequencySXR(this.currentFrequency);

		// 10. Dump key registers for diagnostics
		await this.dumpRegisters();

		console.log('LimeSDR: initialization complete');
	}

	// ── Register Diagnostics ────────────────────────────────────

	private async dumpRegisters(): Promise<void> {
		const regs: Array<[string, number]> = [
			['RESET (0x0020)', REG_RESET],
			['DIQ_PAD (0x0022)', 0x0022],
			['LML_CONF (0x0023)', REG_LML_CONF1],
			['LML1_MAP (0x0024)', REG_LML1_MAP],
			['LML2_MAP (0x0027)', 0x0027],
			['CLK_MUX (0x002A)', REG_CLK_MUX],
			['CLK_SRC (0x002B)', REG_CLK_SRC],
			['AFE_CFG (0x0082)', REG_AFE_CFG],
			['CGEN_CFG (0x0086)', REG_CGEN_CFG],
			['CGEN_DIV (0x0089)', REG_CGEN_DIV],
			['RXTSP_CFG (0x0400)', REG_RXTSP_CFG],
			['RXTSP_DEC (0x0403)', REG_RXTSP_DEC],
			['RXTSP_BYP (0x040C)', REG_RXTSP_BYP],
		];
		const vals: string[] = [];
		for (const [name, addr] of regs) {
			const val = await this.readLMS7002(addr);
			vals.push(`${name}=0x${val.toString(16).padStart(4, '0')}`);
		}
		console.log('LimeSDR LMS7002 regs: ' + vals.join(', '));

		// FPGA registers
		const fpgaRegs: Array<[string, number]> = [
			['BOARD', 0x0000],
			['VERSION', 0x0001],
			['REVISION', 0x0002],
			['PLL_CTRL', 0x0003],
			['DIRECT_CLK', FPGA_REG_DIRECT_CLK],
			['IFACE (0x0008)', FPGA_REG_IFACE],
			['CH_EN (0x0007)', FPGA_REG_CH_EN],
			['CTRL (0x000A)', FPGA_REG_CTRL],
		];
		const fpgaVals: string[] = [];
		for (const [name, addr] of fpgaRegs) {
			const val = await this.readFPGA(addr);
			fpgaVals.push(`${name}=0x${val.toString(16).padStart(4, '0')}`);
		}
		console.log('LimeSDR FPGA regs: ' + fpgaVals.join(', '));
	}

	// ── Analog Filter Bandwidth ─────────────────────────────────

	async setAnalogBandwidth(bwHz: number): Promise<void> {
		const bw = Math.max(0.5e6, Math.min(bwHz, MAX_SAMPLE_RATE));
		const filterIF = bw / 2;
		const adjustedIF = filterIF * 1.3;
		await this.configureTIAFilter(filterIF);
		if (filterIF < 18e6) {
			await this.modifyReg(REG_RBB_EN, 3, 2, 2);
			await this.modifyReg(0x0118, 15, 13, 0);
			const capacitor = Math.max(0, Math.min(2047, Math.trunc(2160e6 / adjustedIF - 103)));
			const resistance =
				adjustedIF < 1.4e6 ? 0 : adjustedIF < 3e6 ? 1 : adjustedIF < 5e6 ? 2 : adjustedIF < 10e6 ? 3 : adjustedIF < 15e6 ? 4 : 5;
			await this.modifyReg(0x0117, 13, 0, (resistance << 11) | capacitor);
		} else {
			await this.modifyReg(REG_RBB_EN, 3, 2, 1);
			await this.modifyReg(0x0118, 15, 13, 1);
			const capacitor = Math.max(0, Math.min(255, Math.trunc(6000e6 / adjustedIF - 50)));
			const resistance = Math.max(0, Math.min(7, Math.trunc(adjustedIF / 10e6 - 3)));
			await this.modifyReg(0x0116, 10, 0, (resistance << 8) | capacitor);
		}

		console.log(`LimeSDR: analog BW=${(bw / 1e6).toFixed(1)} MHz`);
	}

	private async configureTIAFilter(filterIF: number): Promise<void> {
		const tiaGain = getBits(await this.readLMS7002(REG_RFE_GAIN), 1, 0);
		const capacitor = Math.max(
			0,
			Math.min(4095, Math.trunc((tiaGain === 1 ? 5400e6 : 1680e6) / (filterIF * 0.72) - (tiaGain === 1 ? 15 : 10))),
		);
		const compensation = Math.min(15, Math.trunc(capacitor / 100) + (tiaGain === 1 ? 1 : 0));
		await this.modifyReg(0x0112, 15, 0, (compensation << 12) | capacitor);
		await this.modifyReg(0x0114, 8, 5, Math.max(0, 15 - Math.trunc(capacitor / 100)));
	}

	// ── Gain Control ────────────────────────────────────────────

	async setLNAGain(gainDb: number): Promise<void> {
		const regVal = lnaGainToReg(gainDb);
		await this.modifyReg(REG_RFE_GAIN, 9, 6, regVal);
	}

	async setTIAGain(index: number): Promise<void> {
		// index: 0=0dB(reg=1), 1=9dB(reg=2), 2=12dB(reg=3)
		const regVal = Math.max(1, Math.min(3, index + 1));
		await this.modifyReg(REG_RFE_GAIN, 1, 0, regVal);
		await this.configureTIAFilter(this.currentSampleRate / 2);
	}

	async setPGAGain(value: number): Promise<void> {
		// value: 0-31, gain = value - 12 dB
		const clamped = Math.max(0, Math.min(31, value));
		await this.modifyReg(REG_RBB_PGA, 4, 0, clamped);
		const resistance = Math.max(0, Math.min(31, Math.trunc((430 * Math.pow(0.65, clamped / 10) - 110.35) / 20.45 + 16)));
		const capacitor = clamped < 8 ? 3 : clamped < 13 ? 2 : clamped < 21 ? 1 : 0;
		await this.modifyReg(0x011a, 13, 9, resistance);
		await this.modifyReg(0x011a, 6, 0, capacitor);
	}

	async setAntennaPath(index: number): Promise<void> {
		// 0=LNAH, 1=LNAL, 2=LNAW
		const pathMap = [1, 2, 3]; // SEL_PATH_RFE values
		const sel = pathMap[index] ?? 3;

		// Read current register to modify in place
		let reg = await this.readLMS7002(REG_RFE_PATH);
		reg = setBits(reg, 8, 7, sel); // SEL_PATH_RFE [8:7]
		reg = setBits(reg, 4, 4, 1); // EN_INSHSW_LB2 [4] = 1 (disconnect loopback)
		reg = setBits(reg, 3, 3, 1); // EN_INSHSW_LB1 [3] = 1 (disconnect loopback)
		reg = setBits(reg, 2, 2, sel === 2 ? 0 : 1); // EN_INSHSW_L [2]: 0=connect LNAL
		reg = setBits(reg, 1, 1, sel === 3 ? 0 : 1); // EN_INSHSW_W [1]: 0=connect LNAW
		await this.writeLMS7002(REG_RFE_PATH, reg);
	}

	// ── Sample Rate ─────────────────────────────────────────────

	async setRxChannel(channel: number): Promise<void> {
		if (channel !== 0 && channel !== 1) throw new Error(`LimeSDR: unsupported RX channel ${channel}`);
		await this.modifyReg(REG_RESET, 1, 0, 1);
		await this.modifyReg(REG_RFE_PATH, 0, 0, channel);
		await this.modifyReg(REG_RESET, 1, 0, channel + 1);
		await this.setAnalogBandwidth(this.currentSampleRate);
		await this.writeFPGA(FPGA_REG_CH_EN, 1 << channel);
		this.rxChannel = channel;
		console.log(`LimeSDR: selected RX${channel + 1}`);
	}

	async setSampleRate(rate: number): Promise<void> {
		if (!Number.isFinite(rate) || rate < 1e6 || rate > MAX_SAMPLE_RATE) {
			throw new Error(`LimeSDR: unsupported sample rate ${rate}`);
		}
		this.currentSampleRate = rate;
		try {
			await this.setCGENFrequency(rate * 8);
			await this.setAnalogBandwidth(rate);
			await this.modifyReg(REG_RESET, 1, 0, 3);
			await this.configureRxTSP();
			await this.configureLML();
			await this.configureFPGAPLL();
		} finally {
			await this.modifyReg(REG_RESET, 1, 0, this.rxChannel + 1);
		}
	}

	// ── Streaming ───────────────────────────────────────────────

	async startStreaming(callback: (data: ArrayBufferView) => void): Promise<void> {
		if (this.rxRunning) return;
		this.rxLevel.reset();

		// Follow exact LimeSuite Streamer::Start() sequence:

		// 1. Select FPGA chip
		await this.enableFpgaStreaming();

		console.log(`LimeSDR: RX enabled; waiting for USB samples (${NUM_TRANSFERS} transfers, ${TRANSFER_SIZE} bytes each)`);

		let firstPacketLogged = false;
		let resolveStarted!: () => void;
		let rejectStarted!: (error: Error) => void;
		const started = new Promise<void>((resolve, reject) => {
			resolveStarted = resolve;
			rejectStarted = reject;
		});
		const startTimer = setTimeout(() => {
			rejectStarted(
				new Error('LimeSDR: no USB IQ samples received within 3 seconds; check the LML clocks, FPGA interface, and USB connection'),
			);
		}, STREAM_START_TIMEOUT_MS);
		const transfers: Array<Promise<void>> = [];
		this.rxRunning = transfers;

		const transfer = async (): Promise<void> => {
			// Each concurrent transfer gets its own output buffer (avoids race condition)
			const samplesPerTransfer = Math.floor(TRANSFER_SIZE / STREAM_PKT_SIZE) * (STREAM_PAYLOAD / 4);
			const outBuf = new Int8Array(samplesPerTransfer * 2);

			await Promise.resolve(); // Yield to event loop
			while (this.rxRunning === transfers) {
				try {
					const result = await this.dev.transferIn(EP_STREAM_IN_NUM, TRANSFER_SIZE);
					if (this.rxRunning !== transfers) break;
					if (result.status !== 'ok' || !result.data) {
						throw new Error(`USB IQ transfer failed (status=${result.status})`);
					}

					const raw = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
					if (raw.length < STREAM_PKT_SIZE) continue;

					// Log first packet for diagnostics
					if (!firstPacketLogged) {
						firstPacketLogged = true;
						logFirstPacket(raw);
					}

					const numPackets = Math.floor(raw.length / STREAM_PKT_SIZE);
					const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
					this.rxLevel.observe(dv);

					let outPos = 0;
					for (let pkt = 0; pkt < numPackets; pkt++) {
						const base = pkt * STREAM_PKT_SIZE + STREAM_HDR_SIZE;
						for (let j = 0; j < STREAM_PAYLOAD; j += 4) {
							outBuf[outPos++] = dv.getInt16(base + j, true) >> 8; // I
							outBuf[outPos++] = dv.getInt16(base + j + 2, true) >> 8; // Q
						}
					}

					if (outPos > 0) {
						callback(outBuf.subarray(0, outPos));
						resolveStarted();
					}
				} catch (e: unknown) {
					if (this.rxRunning === transfers) {
						const msg = e instanceof Error ? errorMessage(e) : String(e);
						console.error('LimeSDR stream error:', msg);
						rejectStarted(new Error(`LimeSDR: ${msg}`));
					}
					break;
				}
			}
		};

		for (let index = 0; index < NUM_TRANSFERS; index++) transfers.push(transfer());
		try {
			await started;
			console.log('LimeSDR: USB IQ stream active');
		} catch (error) {
			await this.stopStreaming();
			throw error;
		} finally {
			clearTimeout(startTimer);
		}
	}

	async stopStreaming(): Promise<void> {
		const transfers = this.rxRunning;
		this.rxRunning = null;

		// Disable RX in FPGA
		try {
			await this.writeFPGA(FPGA_REG_CTRL, 0x0000);
		} catch (_) {
			/* may fail if USB disconnected */
		}

		if (transfers) {
			let stopTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const settled = await Promise.race([
					Promise.allSettled(transfers).then(() => true),
					new Promise<false>((resolve) => {
						stopTimer = setTimeout(() => resolve(false), STREAM_STOP_TIMEOUT_MS);
					}),
				]);
				if (!settled) {
					console.warn('LimeSDR: cancelling pending IQ transfers before restarting');
					await this.dev.close();
					await Promise.allSettled(transfers);
					await this.dev.open();
					await this.dev.selectConfiguration(1);
					await this.dev.claimInterface(0);
				}
			} finally {
				clearTimeout(stopTimer);
			}
		}
	}

	private async enableFpgaStreaming() {
		await this.writeFPGA(FPGA_REG_CHIP_SEL, 0x0001);

		// 2. Stop any existing streaming (clear RX_EN and TX_EN)
		const ctrl = await this.readFPGA(FPGA_REG_CTRL);
		await this.writeFPGA(FPGA_REG_CTRL, ctrl & ~0x03);

		// 3. Reset timestamp counters (pulse: clear→set→clear)
		// SMPL_NR_CLR = bit 0, TXPCT_LOSS_CLR = bit 1 → mask = 0x03
		let reg9 = await this.readFPGA(FPGA_REG_TSTAMP);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 & ~0x03);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 | 0x03);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 & ~0x03);

		// 4. Reset USB streaming FIFOs (0x00 = stream buffer reset)
		await this.resetStreamBuffers();

		// 5. Configure interface mode: MIMO (0x0100)
		// MIMO mode properly captures I/Q from separate DDR edges
		await this.writeFPGA(FPGA_REG_IFACE, 0x0100);
		await this.writeFPGA(FPGA_REG_CH_EN, 1 << this.rxChannel);

		// 6. Enable RX streaming only (per LimeSuite StartStreaming — TX_EN not needed)
		const ctrl2 = await this.readFPGA(FPGA_REG_CTRL);
		await this.writeFPGA(FPGA_REG_CTRL, ctrl2 | 0x0001); // RX_EN only

		// 7. Post-start counter pulse (bits 3 and 1, i.e. 5<<1 = 0x0A)
		reg9 = await this.readFPGA(FPGA_REG_TSTAMP);
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 | (5 << 1));
		await this.writeFPGA(FPGA_REG_TSTAMP, reg9 & ~(5 << 1));

		await this.resetLogicRegisters();
		await this.dumpRegisters();
	}
}

function logFirstPacket(raw: Uint8Array<ArrayBufferLike>) {
	const hdr = Array.from(raw.slice(0, 16))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join(' ');
	console.log(`LimeSDR: first USB transfer: ${raw.length} bytes, header: ${hdr}`);

	// IQ diagnostic: check if I and Q are independent or identical
	// Per LimeSuite memcpy(complex16_t): word[0]=I, word[1]=Q
	const diagDV = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	let sumII = 0,
		sumQQ = 0,
		sumIQ = 0;
	const pairs: string[] = [];
	const numDiag = Math.min(500, Math.floor((raw.length - STREAM_HDR_SIZE) / 4));
	for (let k = 0; k < numDiag; k++) {
		const off = STREAM_HDR_SIZE + k * 4;
		const iVal = diagDV.getInt16(off, true); // word[0] = I
		const qVal = diagDV.getInt16(off + 2, true); // word[1] = Q
		sumII += iVal * iVal;
		sumQQ += qVal * qVal;
		sumIQ += iVal * qVal;
		if (k < 10) pairs.push(`(I=${iVal},Q=${qVal})`);
	}
	const iRms = Math.sqrt(sumII / numDiag);
	const qRms = Math.sqrt(sumQQ / numDiag);
	const corr = sumII > 0 && sumQQ > 0 ? sumIQ / Math.sqrt(sumII * sumQQ) : 0;
	console.log(`LimeSDR IQ diag: corr=${corr.toFixed(4)}, I_rms=${iRms.toFixed(0)}, Q_rms=${qRms.toFixed(0)}`);
	console.log(`LimeSDR first IQ (word[0]=I, word[1]=Q): ${pairs.join(' ')}`);

	const ratio = iRms > 0 && qRms > 0 ? iRms / qRms : 1;
	if (ratio > 1.5 || ratio < 0.67) {
		console.warn(`LimeSDR: IQ amplitude imbalance (I/Q=${ratio.toFixed(2)}); check interface timing before calibration`);
	}
}
