import type { POCSAGDecoder } from '@/worker/decoders/pocsag';
import type { RDSDecoder } from '@/worker/decoders/rds';
import type { RationalResampler } from '@/worker/streams/dsp-pipeline';
import type { DSDDecoder } from '@/worker/decoders/dsd/dsd-decoder';
import type { RxStreamStats } from '@/radio/types';
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

export interface VfoParams {
	stereo?: boolean;
	adsb?: boolean;
	rtl433?: boolean;
	rtl433SampleRate?: number;
	rtl433Protocols?: string;
	/** Silence only the speaker mix while keeping decoding and transcription running. */
	audioMuted?: boolean;
	freq: number;
	mode: string;
	enabled: boolean;
	deEmphasis: string;
	squelchEnabled: boolean;
	squelchLevel: number;
	lowPass: boolean;
	highPass: boolean;
	bandwidth: number;
	volume: number;
	pocsag: boolean;
	rds: boolean;
	rdsRegion: string;
}

export interface VfoState {
	squelchOpen: boolean;
	squelchDb: number;
	pocsagDecoder: POCSAGDecoder | null;
	rdsDecoder: RDSDecoder | null;
	audioQueue: Float32Array;
	audioQueueLen: number;
	audioRightQueue?: Float32Array;
	audioChannels?: 1 | 2;
	lastMode?: string;
	deemphPrev?: number;
	dcAvg?: number;
	agcGain?: number;
	ssbPhase?: number;
	cwTone?: number;
	currentIfRate?: number;
	audioResampler?: RationalResampler;
	lastBandwidth?: number;
	audioTarget?: Float32Array;
	scratchBuf?: Float32Array;
	/** DSD decoder instance (when mode === 'dsd') */
	dsdDecoder?: DSDDecoder;
	/** Resampler 8000 → 48000 Hz for DSD audio output */
	dsdAudioResampler?: RationalResampler;
	/** Accumulator for DSD decoded audio at 8 kHz */
	dsdAudioBuf?: Float32Array;
	/** Number of valid samples in dsdAudioBuf */
	dsdAudioBufLen?: number;
}

export interface PerfCounters {
	usbCallbacks: number;
	audioCalls: number;
	audioSamplesOut: number;
	dspTimeSum: number;
	dspTimeMax: number;
	inputSamplesSum: number;
	droppedChunks: number;
	msgsSent: number;
	whisperMsgsSent?: number;
	lastReportTime: number;
	lastChunkSize?: number;
	report: PerfReport;
}

export interface PerfReport extends Partial<RxStreamStats> {
	usbFps: number;
	audioFps: number;
	dspAvgMs: number | string;
	dspMaxMs: number | string;
	audioRate: number;
	inputRate: number;
	dropped: number;
	/** Cumulative skipped IQ consumer deliveries since this stream started. */
	droppedTotal?: number;
	chunkSize: number;
	msgRate?: number;
	whisperMsgRate?: number;
	channelAvgMs?: number;
	channelMaxMs?: number;
	channelCpuMs?: number;
}

export interface RxStreamOpts {
	centerFreq: number;
	frequencyShift?: number;
	sampleRate: number;
	fftSize: number;
	spectrumFps?: number;
	sharedChannelization?: boolean;
	whisperEnabled?: boolean;
	gains?: Record<string, number>;
	/** @deprecated Use gains instead */
	lnaGain?: number;
	/** @deprecated Use gains instead */
	vgaGain?: number;
	/** @deprecated Use gains instead */
	ampEnabled?: boolean;
}

export interface RemoteClientState {
	perf?: { audioCalls: number; audioSamplesOut: number; dspTimeSum: number; dspTimeMax: number; msgsSent: number };
	channelization?: { bands: number; vfos: number; sampleRate: number };
	sharedChannelization?: boolean;
	workers: Array<Worker | null>;
	params: Array<VfoParams | null>;
	audioQueues: Array<{ queue: Float32Array; len: number; right?: Float32Array; channels?: 1 | 2 }>;
	mixBuf: Float32Array | null;
	pocsagDecoders: Array<POCSAGDecoder | null>;
	rdsDecoders: Array<RDSDecoder | null>;
	squelchOpen: boolean[];
}

export interface DeviceOpenOpts {
	/** Index in getDevices() disambiguates missing or duplicated serial numbers. */
	deviceIndex?: number;
	vendorId?: number;
	productId?: number;
	serialNumber?: string;
}
