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

// ── LMS64C Protocol ─────────────────────────────────────────────────
export const CMD_GET_INFO = 0x00;
export const CMD_LMS7002_RST = 0x20;
export const CMD_LMS7002_WR = 0x21;
export const CMD_LMS7002_RD = 0x22;
export const CMD_USB_FIFO_RST = 0x40;
export const CMD_BRDSPI_WR = 0x55;
export const CMD_BRDSPI_RD = 0x56;
export const STATUS_UNKNOWN_CMD = 2;

export class LimeSDRCommandError extends Error {
	constructor(
		readonly command: number,
		readonly status: number,
	) {
		super(`LimeSDR: command 0x${command.toString(16)} failed (device status=${status})`);
	}
}

// USB bulk endpoints
export const EP_CTRL_OUT = 0x0f; // Control command output
export const EP_CTRL_IN_NUM = 15; // Control response input (endpoint number for transferIn)
export const EP_STREAM_IN_NUM = 1; // IQ stream input (endpoint number for transferIn)

// Streaming constants
export const TRANSFER_SIZE = 262144; // 256 KB per bulk transfer
export const STREAM_PKT_SIZE = 4096; // FPGA packet size
export const STREAM_HDR_SIZE = 16; // Packet header bytes
export const STREAM_PAYLOAD = STREAM_PKT_SIZE - STREAM_HDR_SIZE; // 4080 bytes of IQ data
export const NUM_TRANSFERS = 8; // Concurrent USB transfers
export const STREAM_START_TIMEOUT_MS = 3000;
export const STREAM_STOP_TIMEOUT_MS = 1000;
export const MAX_SAMPLE_RATE = 61.44e6;

// Reference clock
export const REF_CLK = 30.72e6; // LimeSDR-USB VCTCXO

// VCO frequency ranges
export const CGEN_VCO_MIN = 1930e6;
export const CGEN_VCO_MAX = 2940e6;
export const SX_VCO_MIN = 3800e6; // VCOL low bound
export const SX_VCO_MAX = 7714e6; // VCOH high bound
export const SX_DIV2_THRESHOLD = 5500e6;

// LNA gain table: index = register value (1-15), value = dB
export const LNA_GAIN_DB = [0, 0, 3, 6, 9, 12, 15, 18, 21, 24, 25, 26, 27, 28, 29, 30];

// ── LMS7002M Register Addresses ─────────────────────────────────────
export const REG_RESET = 0x0020; // Reset/enable/MAC
export const REG_LML_CONF1 = 0x0023; // LML mode config
export const REG_LML1_MAP = 0x0024; // LML1 sample mapping
export const REG_CLK_MUX = 0x002a; // Clock muxing
export const REG_CLK_SRC = 0x002b; // MCLK sources
// AFE
export const REG_AFE_CFG = 0x0082; // AFE enables

// CGEN (Clock Generator PLL)
export const REG_CGEN_CFG = 0x0086; // CGEN control (PD, EN_G)
export const REG_CGEN_FRAC_L = 0x0087; // CGEN fractional LSB [15:0]
export const REG_CGEN_INT = 0x0088; // CGEN INT [13:4], FRAC MSB [3:0]
export const REG_CGEN_DIV = 0x0089; // CGEN output divider [10:3]
export const REG_CGEN_CSW = 0x008b; // CGEN VCO CSW [8:1], ICT [13:9]
export const REG_CGEN_CMP = 0x008c; // CGEN comparator [13:12]

// RFE (RX Front End)
export const REG_RFE_EN = 0x010c; // RFE enable [0], PD bits
export const REG_RFE_PATH = 0x010d; // SEL_PATH_RFE [8:7], EN_INSHSW_LB2 [4], LB1 [3], L [2], W [1]
export const REG_RFE_GAIN = 0x0113; // G_LNA [9:6], G_TIA [1:0]

// RBB (RX Baseband)
export const REG_RBB_PGA = 0x0119; // G_PGA_RBB [4:0]

// SX (Synthesizer, register space depends on MAC channel)
export const REG_SX_CFG = 0x011c; // EN_DIV2 [10], EN_INTONLY [9], PD_VCO [1], EN_G [0]
export const REG_SX_FRAC_L = 0x011d; // FRAC LSB [15:0]
export const REG_SX_INT = 0x011e; // INT [13:4], FRAC MSB [3:0]
export const REG_SX_DIV = 0x011f; // DIV_LOCH [8:6]
export const REG_SX_ICT = 0x0120; // ICT_VCO [7:0]
export const REG_SX_VCO = 0x0121; // CSW_VCO [10:3], SEL_VCO [2:1]
export const REG_SX_CMP = 0x0123; // VCO_CMPHO [13:12]

// RBB (RX Baseband)
export const REG_RBB_EN = 0x0115; // RBB enable [0]

// RxTSP (RX Digital Signal Processing)
export const REG_RXTSP_CFG = 0x0400; // EN [0]
export const REG_RXTSP_DEC = 0x0403; // HBD_OVR [14:12]
export const REG_RXTSP_AGC = 0x040a; // AGC_MODE [13:12]
export const REG_RXTSP_BYP = 0x040c; // Various bypass bits

// TxTSP (TX DSP - needed for clock routing)
export const REG_TXTSP_CFG = 0x0200; // EN [0]

// FPGA registers (via board SPI)
export const FPGA_REG_DIRECT_CLK = 0x0005; // Direct clock bypass
export const FPGA_REG_CH_EN = 0x0007; // Channel enable bitmask
export const FPGA_REG_IFACE = 0x0008; // Stream mode [15:8] + sample width [1:0]
export const FPGA_REG_TSTAMP = 0x0009; // Timestamp/counter reset
export const FPGA_REG_CTRL = 0x000a; // RX_EN [0], TX_EN [1]
export const FPGA_REG_MODE = 0x0025; // PLL mode (bit 7 = config enable)
export const FPGA_REG_MN_ODD = 0x0026; // M/N odd and bypass
export const FPGA_REG_C_ODD0 = 0x0027; // C[7:0] odd/bypass
export const FPGA_REG_N_CNT = 0x002a; // N counter
export const FPGA_REG_M_CNT = 0x002b; // M counter
export const FPGA_REG_C0_CNT = 0x002e; // C0 counter
export const FPGA_REG_CHIP_SEL = 0xffff; // FPGA chip select

// ── Helpers ─────────────────────────────────────────────────────────

export function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export function setBits(reg: number, msb: number, lsb: number, value: number): number {
	const mask = ((1 << (msb - lsb + 1)) - 1) << lsb;
	return (reg & ~mask) | ((value << lsb) & mask);
}

export function getBits(reg: number, msb: number, lsb: number): number {
	return (reg >> lsb) & ((1 << (msb - lsb + 1)) - 1);
}

// Find LNA register value for a target dB gain (0-30)
export function lnaGainToReg(gainDb: number): number {
	gainDb = Math.max(0, Math.min(30, gainDb));
	for (let i = 15; i >= 1; i--) {
		if (LNA_GAIN_DB[i] <= gainDb) return i;
	}
	return 1;
}
