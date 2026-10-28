import type { PagerProtocol } from './charsets';

/**
 * Recommended RX channel bandwidth (Hz) per pager protocol, used to give each
 * decoder its own FM channel filter rather than one shared VFO width. Derived
 * from Carson's rule BW = 2 * (peak_deviation + symbol_rate) with a real-signal
 * acquisition margin, bounded by the 12.5/25 kHz channel raster:
 *
 *   POCSAG  +/-4.5 kHz dev, up to 2400 baud -> 2*(4500+2400)=13.8 kHz -> 15 kHz
 *   GSC     +/-4.5 kHz dev, 600 baud        -> 2*(4500+600)=10.2 kHz  -> 12.5 kHz
 *   FLEX    +/-4.8 kHz dev, up to 3200 sym   -> 2*(4800+3200)=16.0 kHz -> 18 kHz
 *
 * POCSAG 512/1200 would be content at 12.5 kHz, but the baud is not known until
 * sync, so the width must cover the fastest mode (2400) the moment a page
 * arrives. FLEX covers A2/A4 (the widest) for the same reason; 4-FSK does not
 * widen the channel (it packs more bits into the same symbol rate), so the
 * symbol rate, not the bit rate, sets the width.
 */
export const PAGER_RX_BANDWIDTH: Record<PagerProtocol, number> = {
	pocsag: 15000,
	gsc: 12500,
	flex: 18000,
};

/**
 * Known FM peak deviation per pager protocol (Hz). Used to normalise the FM
 * discriminator output so a tone at the nominal deviation maps to ±1.0, giving
 * headroom for over-deviation without railing. When the discriminator is set to
 * bandwidth/2 (the default) it can rail past ±1.0 on loud bursts, which drops
 * zero-crossings and slips the bit-recovery clock by one bit per burst.
 *
 * The reference is set ABOVE the nominal deviation (+90% headroom) to absorb
 * post-demod filter overshoot on sharp FSK transitions (the overshoot measured
 * at ~40% on loud bursts, so ~1.5× the nominal keeps the output under ±1.0):
 *   POCSAG/GSC  nominal ±4.5 kHz  → reference 8500 Hz
 *   FLEX        nominal ±4.8 kHz  → reference 9000 Hz
 */
export const PAGER_FM_DEVIATION: Record<PagerProtocol, number> = {
	pocsag: 8500,
	gsc: 8500,
	flex: 9000,
};

/** The pager protocols that run an independent own-bandwidth channel leg. */
export const PAGER_LEG_PROTOCOLS: PagerProtocol[] = ['pocsag', 'gsc', 'flex'];
