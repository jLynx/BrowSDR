/**
 * Top-level FLEX decoder for BrowSDR. Wires the frame-aware 2FSK/4FSK front
 * end (symbol recovery, FIW, SYNC2, data read into the four interleaved phase
 * buffers) to the frame-content decoder (per-word BCH, address + vector parse,
 * alpha / numeric extraction), emitting one FlexMessage per decoded page.
 *
 * Matches the GSCDecoder/POCSAG decoder convention: construct with the audio
 * sample rate and an onMessage callback, then feed FM-demodulated audio via
 * process(). The front end holds state across process() calls.
 */

import { FlexFrontend, RX_STATE_SYNC1, RX_STATE_FIW, RX_STATE_SYNC2, RX_STATE_DATA } from './frontend';
import { FlexFrameDecoder } from './frame';
import { formatFlexTime, formatFlexTimeOnly } from './flextime';
import type { FlexMode, FlexFiw, FlexPhaseData, FlexMessage } from './types';
import type { FlexStatus, FlexRxStage } from './types';
import type { CharsetKey } from '@/worker/decoders/charsets';
import { FLEX_DEFAULT_CHARSET, flexCharsetHandler, flexCodepage } from '@/worker/decoders/charsets';

export class FlexDecoder {
	private readonly frontend: FlexFrontend;
	private frames: FlexFrameDecoder;
	private readonly onMessage: (msg: FlexMessage) => void;
	private charset: CharsetKey;
	private mode: FlexMode | null = null;
	private polarity = 0;
	private lastSyncEvent: { label: string; code: number; ers: boolean } | null = null;

	constructor(audioRate: number, onMessage: (msg: FlexMessage) => void, charset: CharsetKey = FLEX_DEFAULT_CHARSET) {
		this.onMessage = onMessage;
		this.charset = charset;
		// The selected charset is either a handler (Kanji -> 16-bit Shift-JIS
		// extraction, no glyph table) or a 7-bit glyph codepage applied to plain
		// alpha. Resolve both and hand them to the frame decoder.
		this.frames = FlexDecoder.buildFrames(charset);
		this.frontend = new FlexFrontend(audioRate, {
			onLock: (locked: boolean) => {
				// Reset BER and network time when lock is lost so hunt state
				// reports null and stale time from the previous TX doesn't persist.
				if (!locked) {
					// Keep ERS event so badge stays red while the burst continues;
					// clear non-ERS events so a stale codeword doesn't linger.
					if (!this.lastSyncEvent?.ers) this.lastSyncEvent = null;
					this.frames.resetBer();
					this.frames.resetNet();
				} else {
					// Real frame locked — clear any ERS label.
					this.lastSyncEvent = null;
				}
			},
			onMode: (mode: FlexMode, polarity: number) => {
				this.mode = mode;
				this.polarity = polarity;
			},
			onSyncCode: (info) => {
				this.onSyncCode(info);
			},
			onFrame: (phases: FlexPhaseData[], activePhases: number[], fiw: FlexFiw, polarity: number) => {
				// Bitrate (bps) = symbol rate x bits/symbol (4FSK carries 2 bits).
				const levels = this.mode ? this.mode.levels : 2;
				const bps = this.mode ? this.mode.baud * (levels === 4 ? 2 : 1) : 0;
				const msgs = this.frames.decode(phases, activePhases, fiw, polarity);
				// Calculated network timestamp, read AFTER decode so it reflects
				// this frame's clock votes; same for every message in the frame
				// (the BIW clock is per-frame, so all pages share the frame time).
				const flexTime = formatFlexTime(this.frames.getNetInfo(), fiw.frame);
				for (const msg of msgs) {
					msg.baud = bps;
					msg.levels = levels;
					msg.flexTime = flexTime;
					this.onMessage(msg);
				}
			},
		});
	}

	/** Feed a block of FM-demodulated Float32 audio samples. */
	process(samples: Float32Array): void {
		this.frontend.process(samples);
	}

	/**
	 * Handle a non-mode sync-code detection from the front end: a reserved code
	 * (A5-A15, 100%-error-free gated) or the Ar ERS code (reported once per
	 * burst). Record it for the UI status row and print a log line.
	 */
	private onSyncCode(info: { code: number; label: string; ers: boolean; polarity: number }): void {
		this.lastSyncEvent = { label: info.label, code: info.code, ers: info.ers };
		const what = info.ers ? 'FLEX ERS (emergency re-sync) detected' : 'FLEX reserved sync code detected';
		console.info(`${what}: ${info.label} [0x${info.code.toString(16).padStart(4, '0')}]`);
	}

	/** Switch the active FLEX charset. A handler charset (e.g. Kanji) changes
	 * the decoding logic, so the frame decoder is rebuilt for the new mode. */
	setCharset(charset: CharsetKey): void {
		this.charset = charset;
		this.frames = FlexDecoder.buildFrames(charset);
	}

	/** Build a frame decoder for a charset: Kanji -> handler flag (no glyph
	 * table); any other FLEX charset -> its resolved per-protocol codepage. */
	private static buildFrames(charset: CharsetKey): FlexFrameDecoder {
		const kanji = flexCharsetHandler(charset) === 'kanji';
		return new FlexFrameDecoder(kanji, kanji ? undefined : flexCodepage(charset));
	}

	reset(): void {
		this.frontend.reset();
		this.frames.reset();
		this.mode = null;
		this.polarity = 0;
	}

	/**
	 * Live receiver status for the UI. The pipeline stage reflects the PLL lock
	 * and the front end's RX state machine (S1 hunt -> FIW -> S2 -> DATA); mode,
	 * baud and levels come from the detected air mode, and cycle/frame from the
	 * last decoded FIW. Before lock everything but `stage` reads null.
	 */
	getStatus(): FlexStatus {
		const locked = this.frontend.locked;
		const stage = this.rxStage(locked);
		const mode = this.frontend.detectedMode;
		const fiw = this.frontend.lastFiw;
		const net = this.frames.getNetInfo();
		return {
			locked,
			stage,
			inverted: this.frontend.detectedPolarity === 1,
			mode: mode ? mode.label : null,
			baud: mode ? mode.baud : null,
			levels: mode ? mode.levels : null,
			cycle: fiw ? fiw.cycle : null,
			frame: fiw ? fiw.frame : null,
			ber: this.frames.getBer(),
			localId: net.localId,
			coverageZone: net.coverageZone,
			countryCode: net.countryCode,
			tmf: net.tmf,
			date: net.date,
			time: fiw ? formatFlexTimeOnly(net, fiw.frame) : net.time,
			tzOffsetMin: net.tzOffsetMin,
			dst: net.dst,
			groupSlots: this.frames
				.getGroupSlots(this.polarity)
				.map((s) => ({ state: s.state, targetFrame: s.targetFrame, members: s.members.slice() })),
			reasmBuffers: this.frames.getReasmCount(this.polarity),
			lastSyncEvent: this.lastSyncEvent,
			// Time resolution: 0.9375 s when the extended-seconds TZ word is also
			// confirmed, else the 7.5 s coarse TIME step; null with no time.
			timePrecisionSec: net.time === null ? null : net.tzOffsetMin !== null ? 0.9375 : 7.5,
		};
	}

	/** Map the front end's PLL lock + RX state to a UI pipeline stage. */
	private rxStage(locked: boolean): FlexRxStage {
		if (!locked) return 'hunt';
		switch (this.frontend.state) {
			case RX_STATE_FIW:
				return 'fiw';
			case RX_STATE_SYNC2:
				return 'sync2';
			case RX_STATE_DATA:
				return 'data';
			case RX_STATE_SYNC1:
			default:
				return 'sync1';
		}
	}

	get locked(): boolean {
		return this.frontend.locked;
	}
	get detectedMode(): FlexMode | null {
		return this.mode;
	}
	get detectedPolarity(): number {
		return this.polarity;
	}
}

export type { FlexMessage } from './types';
