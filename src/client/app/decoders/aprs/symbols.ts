import type { AprsSymbolCategory, AprsSymbolInfo } from './types';

// APRS 1.0.1 appendix 2, primary symbol table. Codes without an assigned meaning fall back to a generic name.
const PRIMARY: Record<string, [string, AprsSymbolCategory]> = {
	'!': ['Police station', 'facility'],
	'#': ['Digipeater', 'infrastructure'],
	$: ['Phone', 'infrastructure'],
	'%': ['DX cluster', 'infrastructure'],
	'&': ['HF gateway', 'infrastructure'],
	"'": ['Small aircraft', 'aircraft'],
	'(': ['Mobile satellite station', 'mobile'],
	')': ['Wheelchair', 'mobile'],
	'*': ['Snowmobile', 'mobile'],
	'+': ['Red Cross', 'facility'],
	',': ['Scouts', 'facility'],
	'-': ['House', 'infrastructure'],
	'/': ['Dot', 'other'],
	':': ['Fire', 'facility'],
	';': ['Campground', 'facility'],
	'<': ['Motorcycle', 'mobile'],
	'=': ['Train', 'mobile'],
	'>': ['Car', 'mobile'],
	'?': ['File server', 'infrastructure'],
	'@': ['Hurricane forecast', 'weather'],
	A: ['Aid station', 'facility'],
	B: ['BBS', 'infrastructure'],
	C: ['Canoe', 'mobile'],
	E: ['Eyeball', 'other'],
	F: ['Tractor', 'mobile'],
	H: ['Hotel', 'facility'],
	I: ['TCP/IP', 'infrastructure'],
	K: ['School', 'facility'],
	N: ['NTS station', 'infrastructure'],
	O: ['Balloon', 'aircraft'],
	P: ['Police', 'mobile'],
	R: ['Recreational vehicle', 'mobile'],
	S: ['Space shuttle', 'aircraft'],
	T: ['SSTV', 'infrastructure'],
	U: ['Bus', 'mobile'],
	V: ['ATV', 'infrastructure'],
	W: ['Weather service site', 'weather'],
	X: ['Helicopter', 'aircraft'],
	Y: ['Sailboat', 'mobile'],
	'[': ['Person', 'mobile'],
	'\\': ['Direction finding', 'other'],
	']': ['Post office', 'facility'],
	'^': ['Large aircraft', 'aircraft'],
	_: ['Weather station', 'weather'],
	'`': ['Dish antenna', 'infrastructure'],
	a: ['Ambulance', 'mobile'],
	b: ['Bicycle', 'mobile'],
	c: ['Incident command post', 'facility'],
	d: ['Fire station', 'facility'],
	e: ['Horse', 'mobile'],
	f: ['Fire truck', 'mobile'],
	g: ['Glider', 'aircraft'],
	h: ['Hospital', 'facility'],
	i: ['Island (IOTA)', 'other'],
	j: ['Jeep', 'mobile'],
	k: ['Truck', 'mobile'],
	l: ['Laptop', 'other'],
	m: ['Mic-E repeater', 'infrastructure'],
	n: ['Node', 'infrastructure'],
	o: ['Emergency operations center', 'facility'],
	p: ['Dog', 'mobile'],
	r: ['Repeater', 'infrastructure'],
	s: ['Power boat', 'mobile'],
	t: ['Truck stop', 'facility'],
	u: ['Semi truck', 'mobile'],
	v: ['Van', 'mobile'],
	w: ['Water station', 'facility'],
	y: ['Yagi antenna', 'infrastructure'],
};

// Alternate-table codes whose meaning matches a primary symbol and commonly carry an overlay.
const ALTERNATE: Record<string, [string, AprsSymbolCategory]> = {
	'#': ['Digipeater', 'infrastructure'],
	'&': ['Gateway', 'infrastructure'],
	'-': ['House', 'infrastructure'],
	'>': ['Car', 'mobile'],
	_: ['Weather station', 'weather'],
};

/** Readable name and map category for a two-character symbol: table or overlay, then code. */
export function symbolInfo(symbol: string | undefined): AprsSymbolInfo {
	if (!symbol || symbol.length !== 2) return { name: 'No symbol', category: 'other' };
	const [table, code] = symbol;
	if (table === '/') {
		const [name, category] = PRIMARY[code] ?? (/[0-9]/.test(code) ? [`Numbered circle ${code}`, 'other'] : [`Symbol /${code}`, 'other']);
		return { name, category };
	}
	const known = ALTERNATE[code];
	const overlay = table === '\\' ? '' : ` (overlay ${table})`;
	return known ? { name: `${known[0]}${overlay}`, category: known[1] } : { name: `Alternate symbol ${code}${overlay}`, category: 'other' };
}
