/*
RTL-SDR WebUSB driver for BrowSDR
Copyright (c) 2026, jLynx <https://github.com/jLynx>

Based on rtlsdrjs by Sandeep Mistry (Apache 2.0)
  https://github.com/sandeepmistry/rtlsdrjs
Based on Google Radio Receiver by Jacobo Tarrío (Apache 2.0)
  https://github.com/nicholasgasior/nicholasgasior-chrome-apps-radio-receiver

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

// ── USB Protocol Constants ────────────────────────────────────────
export const XTAL_FREQ = 28800000;
export const IF_FREQ = 3570000;
export const BYTES_PER_SAMPLE = 2;
export const TRANSFER_BUFFER_SIZE = 65536;
export const WRITE_FLAG = 0x10;

export const BLOCK = {
	DEMOD: 0x000,
	USB: 0x100,
	SYS: 0x200,
	I2C: 0x600,
};

export const REG = {
	SYSCTL: 0x2000,
	EPA_CTL: 0x2148,
	EPA_MAXPKT: 0x2158,
	DEMOD_CTL: 0x3000,
	DEMOD_CTL_1: 0x300b,
};
