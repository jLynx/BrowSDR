/* eslint-disable max-lines */
// Auto-extracted RDS tables and helper functions
export const PTY_LABELS_EU = [
	'None',
	'News',
	'Current Affairs',
	'Information',
	'Sport',
	'Education',
	'Drama',
	'Culture',
	'Science',
	'Varied',
	'Pop Music',
	'Rock Music',
	'Easy Listening',
	'Light Classical',
	'Serious Classical',
	'Other Music',
	'Weather',
	'Finance',
	'Children',
	'Social Affairs',
	'Religion',
	'Phone In',
	'Travel',
	'Leisure',
	'Jazz Music',
	'Country Music',
	'National Music',
	'Oldies Music',
	'Folk Music',
	'Documentary',
	'Alarm Test',
	'Alarm',
];

// ── NA (RBDS) PTY labels (NRSC-4-B Table 5) ─────────────────────
export const PTY_LABELS_NA = [
	'None',
	'News',
	'Information',
	'Sports',
	'Talk',
	'Rock',
	'Classic Rock',
	'Adult Hits',
	'Soft Rock',
	'Top 40',
	'Country',
	'Oldies',
	'Soft',
	'Nostalgia',
	'Jazz',
	'Classical',
	'R&B',
	'Soft R&B',
	'Language',
	'Religious Music',
	'Religious Talk',
	'Personality',
	'Public',
	'College',
	'Spanish Talk',
	'Spanish Music',
	'Hip Hop',
	'',
	'',
	'Weather',
	'Emergency Test',
	'Emergency',
];

// ── Biquad Filter (Direct Form II Transposed) ────────────────────
export class BiquadSection {
	private b0: number;
	private b1: number;
	private b2: number;
	private a1: number;
	private a2: number;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;

	constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
		this.b0 = b0;
		this.b1 = b1;
		this.b2 = b2;
		this.a1 = a1;
		this.a2 = a2;
	}

	process(x: number): number {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}

	reset(): void {
		this.x1 = 0;
		this.x2 = 0;
		this.y1 = 0;
		this.y2 = 0;
	}
}

export function makeBandpass(centerHz: number, Q: number, sampleRate: number): BiquadSection {
	const w0 = (2 * Math.PI * centerHz) / sampleRate;
	const sinW0 = Math.sin(w0),
		cosW0 = Math.cos(w0);
	const alpha = sinW0 / (2 * Q),
		a0 = 1 + alpha;
	return new BiquadSection(alpha / a0, 0, -alpha / a0, (-2 * cosW0) / a0, (1 - alpha) / a0);
}

/** 4th-order Butterworth LPF (two cascaded biquads, 24 dB/oct rolloff). */
export function makeButterworthLpf4(cutoffHz: number, sampleRate: number): BiquadSection[] {
	return [0.5411961, 1.30656296].map((Q) => {
		const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
		const sinW0 = Math.sin(w0),
			cosW0 = Math.cos(w0);
		const alpha = sinW0 / (2 * Q),
			a0 = 1 + alpha;
		return new BiquadSection((1 - cosW0) / 2 / a0, (1 - cosW0) / a0, (1 - cosW0) / 2 / a0, (-2 * cosW0) / a0, (1 - alpha) / a0);
	});
}

// ── Language Identification Code (IEC 62106 Annex J) ────────────
export const LIC_NAMES: string[] = [
	'Unknown',
	'Albanian',
	'Breton',
	'Catalan',
	'Croatian',
	'Welsh',
	'Czech',
	'Danish',
	'German',
	'English',
	'Spanish',
	'Esperanto',
	'Estonian',
	'Basque',
	'Faroese',
	'French',
	'Frisian',
	'Irish',
	'Gaelic',
	'Galician',
	'Icelandic',
	'Italian',
	'Lappish',
	'Latin',
	'Latvian',
	'Luxembourgish',
	'Lithuanian',
	'Hungarian',
	'Maltese',
	'Dutch',
	'Norwegian',
	'Occitan',
	'Polish',
	'Portuguese',
	'Romanian',
	'Romansh',
	'Serbian',
	'Slovak',
	'Slovene',
	'Finnish',
	'Swedish',
	'Turkish',
	'Flemish',
	'Walloon',
	...Array<string>(20).fill('Unknown'),
	'Background',
	'Unknown',
	'Unknown',
	'Unknown',
	'Unknown',
	'Zulu',
	'Vietnamese',
	'Uzbek',
	'Urdu',
	'Ukrainian',
	'Thai',
	'Telugu',
	'Tatar',
	'Tamil',
	'Tajik',
	'Swahili',
	'Sranan Tongo',
	'Somali',
	'Sinhalese',
	'Shona',
	'Serbo-Croatian',
	'Ruthenian',
	'Russian',
	'Quechua',
	'Pashto',
	'Punjabi',
	'Persian',
	'Papiamento',
	'Oriya',
	'Nepali',
	'Ndebele',
	'Marathi',
	'Moldovan',
	'Malay',
	'Malagasy',
	'Macedonian',
	'Laotian',
	'Korean',
	'Khmer',
	'Kazakh',
	'Kannada',
	'Japanese',
	'Indonesian',
	'Hindi',
	'Hebrew',
	'Hausa',
	'Guarani',
	'Gujarati',
	'Greek',
	'Georgian',
	'Fulah',
	'Dari',
	'Chuvash',
	'Chinese',
	'Burmese',
	'Bulgarian',
	'Bengali',
	'Belarusian',
	'Bambara',
	'Azerbaijani',
	'Assamese',
	'Armenian',
	'Arabic',
	'Amharic',
];

// ── ECC → country code matrix (IEC 62106 Annex D / NRSC-4-B Annex N) ──
// Index 0..14 = CC nibble values 1..15 (CC=0 is invalid)
export const ECC_TABLE: Record<number, string[]> = {
	0xe0: ['DE', 'DZ', 'AD', 'IL', 'IT', 'BE', 'RU', 'PS', 'AL', 'AT', 'HU', 'MT', 'DE', '--', 'EG'],
	0xe1: ['GR', 'CY', 'SM', 'CH', 'JO', 'FI', 'LU', 'BG', 'DK', 'GI', 'IQ', 'GB', 'LY', 'RO', 'FR'],
	0xe2: ['MA', 'CZ', 'PL', 'VA', 'SK', 'SY', 'TN', '--', 'LI', 'IS', 'MC', 'LT', 'RS', 'ES', 'NO'],
	0xe3: ['ME', 'IE', 'TR', 'MK', '--', '--', '--', 'NL', 'LV', 'LB', 'AZ', 'HR', 'KZ', 'SE', 'BY'],
	0xe4: ['MD', 'EE', 'KG', '--', '--', 'UA', 'XK', 'PT', 'SI', 'AM', '--', 'GE', '--', '--', 'BA'],
	0xa0: ['US', 'US', 'US', 'US', 'US', 'US', 'US', 'US', 'US', 'US', 'US', '--', 'US', 'US', '--'],
	0xa1: ['--', '--', '--', '--', '--', '--', '--', '--', '--', '--', 'CA', 'CA', 'CA', 'CA', 'GL'],
	0xf0: ['AU', 'AU', 'AU', 'AU', 'AU', 'AU', 'AU', 'AU', 'SA', 'AF', 'MM', 'CN', 'KP', 'BH', 'MY'],
	0xf1: ['KI', 'BT', 'BD', 'PK', 'FJ', 'OM', 'NR', 'IR', 'NZ', 'SB', 'BN', 'LK', 'TW', 'KR', 'HK'],
	0xf2: ['KW', 'QA', 'KH', 'WS', 'IN', 'MO', 'VN', 'PH', 'JP', 'SG', 'MV', 'ID', 'AE', 'NP', 'VU'],
};

export function eccToCountry(pi: number, ecc: number): string {
	const cc = (pi >> 12) & 0xf;
	const row = ECC_TABLE[ecc];
	if (!row || cc < 1) return '--';
	return row[cc - 1] || '--';
}

// ── PI coverage area codes (EN 50067 Annex D.4) ─────────────────
export const COVERAGE_NAMES: Record<number, string> = {
	0: 'Local',
	1: 'International',
	2: 'National',
	3: 'Supra-regional',
	4: 'R1',
	5: 'R2',
	6: 'R3',
	7: 'R4',
	8: 'R5',
	9: 'R6',
	0xa: 'R7',
	0xb: 'R8',
	0xc: 'R9',
	0xd: 'R10',
	0xe: 'R11',
	0xf: 'R12',
};

// ── RBDS callsign decode (NRSC-4-B Annex D) ─────────────────────
// Standard 4-letter: PI 0x1000-0x54A7 -> K+3 letters, 0x54A8-0x994F -> W+3 letters
// 3-letter exceptions: 0x9950-0x9EFF (abbreviated legacy callsigns)
export function rbdsCallsign(pi: number): string | null {
	// Nibble-zero adjustments per NRSC-4-B D.7
	if ((pi & 0xfff0) === 0xafa0 && (pi & 0xf) < 0xa) pi = (pi << 12) & 0xffff;
	else if ((pi & 0xff00) === 0xaf00) pi = (pi << 8) & 0xffff;
	else if ((pi & 0xf000) === 0xa000) pi = (((pi & 0x0f00) << 4) | (pi & 0x00ff)) & 0xffff;

	if (pi >= 0x1000 && pi <= 0x994f) {
		let prefix: string, val: number;
		if (pi <= 0x54a7) {
			prefix = 'K';
			val = pi - 0x1000;
		} else {
			prefix = 'W';
			val = pi - 0x54a8;
		}
		return (
			prefix +
			String.fromCharCode(65 + (Math.trunc(val / 676) % 26)) +
			String.fromCharCode(65 + (Math.trunc(val / 26) % 26)) +
			String.fromCharCode(65 + (val % 26))
		);
	}
	return null;
}

// ── ODA Application IDs (IEC 62106 Table M.1) ───────────────────
export const _ODA_AIDS: Record<number, string> = {
	0x0093: 'Cross-referencing DAB',
	0x0bcb: 'BBC Alert',
	0x0c24: 'ZIP/ZIP+',
	0x1c00: 'TMC-Alert C',
	0x4bd7: 'RadioText Plus (RT+)',
	0x4d2c: 'TMC',
	0x4d44: 'UECP (RDS-TMC)',
	0x4e2c: 'TMC-Alert B',
	0x6552: 'RDS2 Uplink',
	0x7373: 'Enhanced RadioText (eRT)',
	0xc350: 'RDS Pager',
	0x3dc5: 'RDS Pager',
	0x9b53: 'DAB Cross-referencing',
	0xab84: 'Météo',
	0xcd46: 'RDS2 I-data',
	0xcd47: 'RDS2 Extra',
};

// ── AF frequency decode (IEC 62106 §6.2.1.6) ────────────────────
// Returns frequency in units of kHz*10 (i.e. 100 Hz) for FM.
// LF/MF frequencies use decodeLfMfCode() instead.
// Codes 224-249 = count codes; 250 = LF/MF follows; 205 = filler -- all handled in processAfPair.
// RBDS (NRSC-4-B) retains the IEC 62106 100 kHz FM encoding; the North American
// channel raster does not change how AF codes are encoded.
export function decodeAfCode(code: number, _region?: string): number | null {
	if (code >= 1 && code <= 204) {
		return Math.round((875 + code) * 100);
	}
	return null;
}

// Decode a LF/MF code directly (code 1-135).
// Region affects MF: RDS (EU) uses 9 kHz grid from 531 kHz; RBDS (NA) uses 10 kHz from 540 kHz.
// Returns frequency in kHz (not kHz*10 like FM).
export function decodeLfMfCode(code: number, region = 'eu'): number | null {
	if (code >= 1 && code <= 15) return 153 + (code - 1) * 9; // LF: same for both regions
	if (code >= 16 && code <= 135)
		return region === 'na'
			? 540 + (code - 16) * 10 // RBDS: 540-1700 kHz, 10 kHz grid
			: 531 + (code - 16) * 9; // RDS: 531-1602 kHz, 9 kHz grid
	return null;
}

// ── RT+ content type names (IEC 62106-6 Table 3) ────────────────
export const RTPLUS_TAGS: Record<number, string> = {
	1: 'Title',
	2: 'Album',
	3: 'Track Number',
	4: 'Artist',
	5: 'Composition',
	6: 'Movement',
	7: 'Conductor',
	8: 'Composer',
	9: 'Band',
	10: 'Comment',
	11: 'Genre',
	12: 'News',
	13: 'News Local',
	14: 'Stock Market',
	15: 'Sport',
	16: 'Lottery',
	17: 'Horoscope',
	18: 'Daily Dilemma',
	19: 'Health',
	20: 'Event',
	21: 'Scene',
	22: 'Cinema',
	23: 'TV',
	24: 'Date/Time',
	25: 'Weather',
	26: 'Traffic',
	27: 'Alarm',
	28: 'Advertisement',
	29: 'URL',
	30: 'Other',
	31: 'Studio',
	32: 'Phone',
	33: 'Meeting Place',
	34: 'Stationname Long',
};

// ── IEC 62106 Annex E — RDS character set (EU only; RBDS uses ASCII) ─────────
// Maps code points 0x00-0xFF to Unicode strings. The lower 128 mostly match
// ASCII with a few exceptions (0x24=¤, 0x5E=―, 0x60=║, 0x7E=¯, 0x7F=DEL→space).
// The upper 128 are European accented/special characters.
// Source: osmocom-analog src/radio/rds_tables.c rds_charmap[].
export const RDS_CHARSET: string[] = [
	// 0x00-0x0F control (map to space except LF/CR)
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	'\n',
	' ',
	' ',
	'\r',
	' ',
	' ',
	// 0x10-0x1F
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	' ',
	// 0x20-0x2F  (0x24 = ¤ currency sign, not $)
	' ',
	'!',
	'"',
	'#',
	'¤',
	'%',
	'&',
	"'",
	'(',
	')',
	'+',
	'+',
	',',
	'-',
	'.',
	'/',
	// 0x30-0x3F
	'0',
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	':',
	';',
	'<',
	'=',
	'>',
	'?',
	// 0x40-0x4F
	'@',
	'A',
	'B',
	'C',
	'D',
	'E',
	'F',
	'G',
	'H',
	'I',
	'J',
	'K',
	'L',
	'M',
	'N',
	'O',
	// 0x50-0x5F  (0x5E = ― horizontal bar, 0x5F = _)
	'P',
	'Q',
	'R',
	'S',
	'T',
	'U',
	'V',
	'W',
	'X',
	'Y',
	'Z',
	'[',
	'\\',
	']',
	'―',
	'_',
	// 0x60-0x6F  (0x60 = ║ double vertical bar)
	'║',
	'a',
	'b',
	'c',
	'd',
	'e',
	'f',
	'g',
	'h',
	'i',
	'j',
	'k',
	'l',
	'm',
	'n',
	'o',
	// 0x70-0x7F  (0x7E = ¯ macron, 0x7F = space)
	'p',
	'q',
	'r',
	's',
	't',
	'u',
	'v',
	'w',
	'x',
	'y',
	'z',
	'{',
	'|',
	'}',
	'¯',
	' ',
	// 0x80-0x8F
	'á',
	'à',
	'é',
	'è',
	'í',
	'ì',
	'ó',
	'ò',
	'ú',
	'ù',
	'Ñ',
	'Ç',
	'Ş',
	'ß',
	'¡',
	'Ĳ',
	// 0x90-0x9F
	'â',
	'ä',
	'ê',
	'ë',
	'î',
	'ï',
	'ô',
	'ö',
	'û',
	'ü',
	'ñ',
	'ç',
	'ş',
	'ğ',
	'ı',
	'ĳ',
	// 0xA0-0xAF
	'ª',
	'α',
	'©',
	'‰',
	'Ğ',
	'ě',
	'ň',
	'ő',
	'π',
	'€',
	'£',
	'$',
	'←',
	'↑',
	'→',
	'↓',
	// 0xB0-0xBF
	'º',
	'¹',
	'²',
	'³',
	'±',
	'İ',
	'ń',
	'ű',
	'µ',
	'¿',
	'÷',
	'°',
	'¼',
	'½',
	'¾',
	'§',
	// 0xC0-0xCF
	'Á',
	'À',
	'É',
	'È',
	'Í',
	'Ì',
	'Ó',
	'Ò',
	'Ú',
	'Ù',
	'Ř',
	'Č',
	'Š',
	'Ž',
	'Đ',
	'Ŀ',
	// 0xD0-0xDF
	'Â',
	'Ä',
	'Ê',
	'Ë',
	'Î',
	'Ï',
	'Ô',
	'Ö',
	'Û',
	'Ü',
	'ř',
	'č',
	'š',
	'ž',
	'đ',
	'ŀ',
	// 0xE0-0xEF
	'Ã',
	'Å',
	'Æ',
	'Œ',
	'Ŷ',
	'Ý',
	'Õ',
	'Ø',
	'Þ',
	'Ŋ',
	'Ŕ',
	'Ć',
	'Ś',
	'Ź',
	'Ŧ',
	'ð',
	// 0xF0-0xFF
	'ã',
	'å',
	'æ',
	'œ',
	'ŵ',
	'ý',
	'õ',
	'ø',
	'þ',
	'ŋ',
	'ŕ',
	'ć',
	'ś',
	'ź',
	'ŧ',
	' ',
];

/** Decode one RDS byte to a string using the region's charset.
 *  EU uses IEC 62106 Annex E; RBDS/NA uses plain ASCII. */
export function rdsChar(code: number, region: string): string {
	if (region === 'na') return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : ' ';
	return RDS_CHARSET[code] ?? ' ';
}

// ── RT+ content type names (IEC 62106-6 Table A.1) ──────────────
export const RTPLUS_TYPES: Array<string | null> = [
	null, // 0: dummy_class (no tag)
	'Title',
	'Album',
	'Track#',
	'Artist',
	'Composition',
	'Movement',
	'Conductor',
	'Composer',
	'Band',
	'Comment',
	'Genre', // 1-11
	'News',
	'Local News',
	'Stock Market',
	'Sport',
	'Lottery',
	'Horoscope',
	'Daily Div.',
	'Health',
	'Event',
	'Scene',
	'Cinema',
	'TV',
	'Date/Time',
	'Weather',
	'Traffic',
	'Alarm',
	'Ad',
	'URL',
	'Other Info', // 12-30
	'Station (short)',
	'Station (long)', // 31-32
	'Prog. Now',
	'Prog. Next',
	'Prog. Part',
	'Host',
	'Editorial',
	'Frequency',
	'Homepage',
	'Subchannel', // 33-40
	'Hotline',
	'Studio Phone',
	'Other Phone', // 41-43
	'SMS Studio',
	'SMS Other', // 44-45
	'Email Hotline',
	'Email Studio',
	'Email Other', // 46-48
	'MMS',
	'Chat',
	'Chat Centre',
	'Vote Q',
	'Vote Centre', // 49-53
	null,
	null,
	null,
	null,
	null, // 54-58: reserved
	'Place',
	'Appointment',
	'Identifier',
	'Purchase',
	'Get Data', // 59-63
];
