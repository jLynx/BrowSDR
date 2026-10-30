import type { AppInstance } from './receiver.types';

/** Drop telemetry tied to an old input stream while retaining decoder settings. */
export function clearDecoderSources(receiver: AppInstance): void {
	receiver.adsb.sources = [];
	receiver.adsb.status = [];
	receiver.ais.sources = [];
	receiver.radiosonde.sources = [];
	receiver.ais.status = [];
	receiver.radiosonde.status = [];
	receiver.rtk.status = [];
	receiver.rtk.sources = [];
	receiver.rtk.frames = [];
	receiver.rtk.frequencies = [];
	receiver.ble.status = [];
	receiver.acars.status = [];
	receiver.acars.sources = [];
	receiver.aprs.status = [];
	receiver.aprs.sources = [];
}
