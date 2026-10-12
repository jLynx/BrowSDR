import { describe, expect, it } from 'vitest';
import { aircraftIconKind, aircraftIconElement } from '@/app/decoders/adsb/map/icons';
import { updateAircraft } from '@/worker/decoders/adsb/messages';
import { validAdsbMessage } from '@/worker/decoders/adsb/validation';
import { aircraftColor } from '@/app/decoders/adsb/map/colors';
import { aircraftTooltip } from '@/app/decoders/adsb/map/tooltip';

describe('ADS-B aircraft category icons', () => {
	it('matches the altitude palette and keeps unknown altitude grey', () => {
		expect(aircraftColor()).toBe('hsl(0, 0%, 75%)');
		expect(aircraftColor(0)).toBe('hsl(20, 88%, 50%)');
		expect(aircraftColor(40000)).toBe('hsl(300, 88%, 43%)');
		expect(aircraftColor(40000, true)).toBe('hsl(300, 95%, 48%)');
	});
	it('shows received fields in the hover card and treats metadata as text', () => {
		const record = { icao: '123456', lastSeen: Date.now(), messages: 1, callsign: 'TEST123', squawk: '0123', altitude: 2000, speed: 100 };
		const card = aircraftTooltip(record, {
			registration: '<img src=x>',
			manufacturer: '',
			model: '',
			type: 'H1T',
			operator: 'Example',
			owner: '',
		});
		expect(card.textContent).toContain('TEST123');
		expect(card.textContent).toContain('0123');
		expect(card.textContent).toContain('2,000 ft');
		expect(card.querySelector('img')).toBeNull();
	});
	it('decodes a broadcast rotorcraft category and validates it across the worker boundary', () => {
		const bytes = new Uint8Array(14);
		bytes[4] = (4 << 3) | 7;
		const record = { icao: '123456', lastSeen: 0, messages: 0, category: 0 };
		updateAircraft(bytes, record, 1000);
		expect(record.category).toBe(7);
		expect(aircraftIconKind(record)).toBe('helicopter');
		const message = { type: 'adsb', freq: 1090, status: { state: 'receiving', samples: 0, frames: 0, message: '' }, aircraft: [record] };
		expect(validAdsbMessage(message)).toBe(true);
		record.category = 100;
		expect(validAdsbMessage(message)).toBe(false);
		bytes[4] = 4 << 3;
		updateAircraft(bytes, record, 2000);
		expect(record).not.toHaveProperty('category');
	});
	it('uses database classification when no broadcast category is available', () => {
		expect(aircraftIconKind({}, 'H2T')).toBe('helicopter');
		expect(aircraftIconKind({}, 'UHEL')).toBe('helicopter');
		expect(aircraftIconKind({}, 'GLID')).toBe('glider');
		expect(aircraftIconKind({}, 'L2J')).toBe('plane');
		expect(aircraftIconKind({ category: 7 }, 'L2J')).toBe('helicopter');
		expect(aircraftIconKind({ category: 10 })).toBe('balloon');
		expect(aircraftIconKind({ category: 9 })).toBe('glider');
	});
	it('renders a distinct helicopter silhouette with track rotation and selection styling', () => {
		const record = { icao: '123456', lastSeen: 0, messages: 1, category: 7, heading: 90 };
		const icon = aircraftIconElement(record, true);
		expect(icon.dataset.aircraftKind).toBe('helicopter');
		expect(icon.classList.contains('selected')).toBe(true);
		expect(icon.style.transform).toBe('rotate(90deg)');
		expect(icon.innerHTML).not.toBe(aircraftIconElement({ ...record, category: 1 }, false).innerHTML);
	});
});
