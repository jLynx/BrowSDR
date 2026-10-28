import type { RDSMessage } from '@/worker/decoders/types';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RdsStatus } from '@/worker/decoders/types';

const EMPTY_STATION = {
	ps: '',
	rt: '',
	pi: '',
	pty: 0,
	ptyLabel: '',
	tp: null as boolean | null,
	ta: null as boolean | null,
	freq: '',
	ptyn: '',
	ct: '',
	ctUtcOffset: 0 as number | null,
	ecc: -1,
	countryName: '',
	lic: -1,
	languageName: '',
	af: [] as number[],
	afMethod: '' as string,
	hasTmc: false,
	tmcId: -1,
	rtPlusItem1: '',
	rtPlusItem1Tag: 0,
	rtPlusItem1Name: '',
	rtPlusItem2: '',
	rtPlusItem2Tag: 0,
	rtPlusItem2Name: '',
	rtPlusRunning: false,
	psCharStatus: [] as number[],
	rtCharStatus: [] as number[],
	// Group 1A extras
	la: false,
	opc: 0,
	rpc: 0,
	rpcGroupDesig: 0,
	rpcBattSync: 0,
	pagingOpc: -1,
	pagingPac: -1,
	ewsChannel: -1,
	broadcasterData: -1,
	pinDay: 0,
	pinHour: 0,
	pinMinute: 0,
	// PI breakdown
	piCc: 0,
	piCoverage: 0,
	piCoverageName: '',
	piRef: 0,
	piCallsign: '' as string | null,
	// Group 0/15B MS + DI
	ms: null as boolean | null,
	di: -1,
	diStereo: false,
	diArtHead: false,
	diCompressed: false,
	diDynPty: false,
	// eRT (Enhanced RadioText)
	eRT: '' as string,
	eRTPartial: '' as string,
	eRTCharStatus: [] as number[],
	// eRT+ (ODA AID 0x4BD8) -- independent from RT+
	eRTPlusItem1: '',
	eRTPlusItem1Tag: 0,
	eRTPlusItem1Name: '',
	eRTPlusItem2: '',
	eRTPlusItem2Tag: 0,
	eRTPlusItem2Name: '',
	eRTPlusRunning: false,
	// EON cross-referenced networks
	eonNetworks: {} as Record<
		string,
		{
			pi: string;
			ps?: string;
			tp: boolean;
			ta: boolean;
			af?: number[];
			mappedFreqs?: Array<{ tuned: number; other: number }>;
			ptyOn?: number;
			pinDay?: number;
			pinHour?: number;
			pinMinute?: number;
		}
	>,
};

export const rdsMethods = {
	toggleRdsPanel(this: AppInstance) {
		this.rds.panelOpen = !this.rds.panelOpen;
	},
	/** Get (or create) the per-VFO RDS station state */
	_rdsStation(this: AppInstance, vfoIndex: number) {
		if (!this.rds.stations[vfoIndex]) {
			// Spread EMPTY_STATION but allocate a fresh eonNetworks object so
			// stations don't share the same mutable reference.
			this.rds.stations[vfoIndex] = { ...EMPTY_STATION, eonNetworks: {} };
		}
		return this.rds.stations[vfoIndex];
	},
	/** Get the active VFO's RDS station (for display in header) */
	rdsActive(this: AppInstance) {
		return this.rds.stations[this.activeVfoIndex] || EMPTY_STATION;
	},
	/** Format one AF frequency for display.
	 *  FM: stored as kHz*10 (>= 8750) → show as MHz e.g. "104.5".
	 *  LF/MF: stored as plain kHz (≤ 1700) → show with "k" suffix e.g. "153k". */
	formatAfFreq(_this: unknown, f: number): string {
		if (f > 1700) return (f / 1000).toFixed(1); // FM: kHz*10 → MHz
		return f + 'k'; // LF/MF: plain kHz
	},
	/** Get all VFOs that have RDS data, as an array with vfoIndex attached */
	rdsStationList(this: AppInstance): Array<{
		vfoIndex: number;
		ps: string;
		rt: string;
		pi: string;
		pty: number;
		ptyLabel: string;
		tp: boolean | null;
		ta: boolean | null;
		freq: string;
	}> {
		const result: Array<AppInstance['rds']['stations'][number] & { vfoIndex: number }> = [];
		for (const key of Object.keys(this.rds.stations)) {
			const idx = Number(key);
			const stn = this.rds.stations[idx];
			if (stn && (stn.ps || stn.pi || stn.rt)) result.push({ ...stn, vfoIndex: idx });
		}
		return result;
	},
	_onRdsMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: RDSMessage) {
		const time = new Date().toLocaleTimeString();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		const stn = this._rdsStation(vfoIndex);
		this._applyRdsStnFields(stn, msg, time, freq, vfoIndex);
		this._applyRdsOdaFields(stn, msg, time, freq, vfoIndex);
		Promise.resolve(
			this.$nextTick(() => {
				const el = this.$refs.rdsBody;
				if (el) el.scrollTop = el.scrollHeight;
			}),
		).catch((error: unknown) => console.error(error));
	},
	/** Apply simple station field updates from an RDS message. */
	_applyRdsStnFields(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		this._applyRdsTextFields(stn, msg, time, freq, vfoIndex);
		this._applyRdsFlagFields(stn, msg, time, freq, vfoIndex);
	},
	/** Apply text/display fields: PI, PS, RT, PTYN, CT. */
	_applyRdsTextFields(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		if (msg.pi !== undefined) {
			stn.pi = msg.pi;
			stn.freq = freq;
			if (msg.piCc !== undefined) stn.piCc = msg.piCc;
			if (msg.piCoverage !== undefined) stn.piCoverage = msg.piCoverage;
			if (msg.piCoverageName !== undefined) stn.piCoverageName = msg.piCoverageName;
			if (msg.piRef !== undefined) stn.piRef = msg.piRef;
			if (msg.piCallsign !== undefined) stn.piCallsign = msg.piCallsign;
		}
		if (msg.piCallsign !== undefined && msg.pi === undefined) stn.piCallsign = msg.piCallsign;
		if (msg.ps !== undefined) {
			stn.ps = msg.ps;
			stn.psCharStatus = msg.psCharStatus ?? [];
			stn.freq = freq;
			this.rds.log.push({ time, field: 'PS', value: msg.ps, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.rt !== undefined) {
			stn.rt = msg.rt;
			stn.rtCharStatus = msg.rtCharStatus ?? [];
			this.rds.log.push({ time, field: 'RT', value: msg.rt, freq, vfoIndex, group: msg.srcGroup, abFlag: msg.srcAbFlag });
		}
		if (msg.ptyn !== undefined) {
			stn.ptyn = msg.ptyn;
			this.rds.log.push({ time, field: 'PTYN', value: msg.ptyn, freq, vfoIndex, group: msg.srcGroup, abFlag: msg.srcAbFlag });
		}
		if (msg.ct !== undefined) {
			stn.ct = msg.ct;
			stn.ctUtcOffset = msg.ctUtcOffset ?? null;
			this.rds.log.push({ time, field: 'CT', value: msg.ct, freq, vfoIndex, group: msg.srcGroup });
		}
	},
	/** Apply flag/metadata fields: PTY, TP, TA, ECC, LIC, AF, DI, PIN, paging, EWS. */
	_applyRdsFlagFields(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		this._applyRdsServiceMeta(stn, msg);
		this._applyRdsDiPinPaging(stn, msg, time, freq, vfoIndex);
	},
	/** Apply service metadata: PTY, TP, TA, LA, MS, AF, TMC flag, ECC, LIC, RPC, broadcaster. */
	_applyRdsServiceMeta(this: AppInstance, stn: ReturnType<AppInstance['_rdsStation']>, msg: RDSMessage) {
		if (msg.pty !== undefined) {
			stn.pty = msg.pty;
			stn.ptyLabel = msg.ptyLabel || '';
		}
		if (msg.tp !== undefined) stn.tp = msg.tp;
		if (msg.ta !== undefined) stn.ta = msg.ta;
		if (msg.la !== undefined) stn.la = msg.la;
		if (msg.ms !== undefined) stn.ms = msg.ms;
		if (msg.af !== undefined) {
			stn.af = msg.af;
			if (msg.afMethod) stn.afMethod = msg.afMethod;
		}
		if (msg.hasTmc) {
			stn.hasTmc = true;
			if (msg.tmcId !== undefined) stn.tmcId = msg.tmcId;
		}
		if (msg.ecc !== undefined) {
			stn.ecc = msg.ecc;
			stn.countryName = msg.countryName || '';
			if (msg.opc !== undefined) stn.opc = msg.opc;
		}
		if (msg.lic !== undefined) {
			stn.lic = msg.lic;
			stn.languageName = msg.languageName || '';
		}
		if (msg.rpc !== undefined) {
			stn.rpc = msg.rpc;
			stn.rpcGroupDesig = msg.rpcGroupDesig ?? 0;
			stn.rpcBattSync = msg.rpcBattSync ?? 0;
		}
		if (msg.broadcasterData !== undefined) stn.broadcasterData = msg.broadcasterData;
	},
	/** Apply decoder ID bits, Programme Item Number, paging OPC/PAC, EWS channel. */
	_applyRdsDiPinPaging(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		if (msg.di !== undefined) {
			stn.di = msg.di;
			stn.diStereo = msg.diStereo ?? false;
			stn.diArtHead = msg.diArtHead ?? false;
			stn.diCompressed = msg.diCompressed ?? false;
			stn.diDynPty = msg.diDynPty ?? false;
		}
		if (msg.pin !== undefined && msg.pinDay !== undefined) {
			stn.pinDay = msg.pinDay;
			stn.pinHour = msg.pinHour ?? 0;
			stn.pinMinute = msg.pinMinute ?? 0;
		}
		if (msg.pagingOpc !== undefined) {
			stn.pagingOpc = msg.pagingOpc;
			stn.pagingPac = msg.pagingPac ?? 0;
			this.rds.log.push({
				time,
				field: 'PAGING-ID',
				value: `OPC=${msg.pagingOpc} PAC=${msg.pagingPac ?? 0}${msg.pagingPac === 0 ? ' (all areas)' : ''}`,
				freq,
				vfoIndex,
				group: msg.srcGroup,
			});
		}
		if (msg.ewsChannel !== undefined) {
			stn.ewsChannel = msg.ewsChannel;
			this.rds.log.push({ time, field: 'EWS', value: `Channel ${msg.ewsChannel}`, freq, vfoIndex });
		}
	},
	/** Apply ODA/advanced field updates: RT+, eRT+, eRT, EON, TMC, paging. */
	_applyRdsOdaFields(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		this._applyRdsRtPlusFields(stn, msg, time, freq, vfoIndex);
		this._applyRdsEonPagingFields(stn, msg, time, freq, vfoIndex);
	},
	/** Apply RT+ and eRT+ tag fields. */
	_applyRdsRtPlusFields(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		if (msg.rtPlusItem1 !== undefined) {
			stn.rtPlusItem1 = msg.rtPlusItem1 || '';
			stn.rtPlusItem1Tag = msg.rtPlusItem1Tag || 0;
			stn.rtPlusItem1Name = msg.rtPlusItem1Name || '';
			stn.rtPlusItem2 = msg.rtPlusItem2 || '';
			stn.rtPlusItem2Tag = msg.rtPlusItem2Tag || 0;
			stn.rtPlusItem2Name = msg.rtPlusItem2Name || '';
			if (msg.rtPlusRunning !== undefined) stn.rtPlusRunning = msg.rtPlusRunning;
			const log = this._rtPlusLogValue(msg.rtPlusItem1Name, msg.rtPlusItem1, msg.rtPlusItem2Name, msg.rtPlusItem2);
			if (log) this.rds.log.push({ time, field: 'RT+', value: log, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.eRTPlusItem1 !== undefined) {
			stn.eRTPlusItem1 = msg.eRTPlusItem1 || '';
			stn.eRTPlusItem1Tag = msg.eRTPlusItem1Tag || 0;
			stn.eRTPlusItem1Name = msg.eRTPlusItem1Name || '';
			stn.eRTPlusItem2 = msg.eRTPlusItem2 || '';
			stn.eRTPlusItem2Tag = msg.eRTPlusItem2Tag || 0;
			stn.eRTPlusItem2Name = msg.eRTPlusItem2Name || '';
			if (msg.eRTPlusRunning !== undefined) stn.eRTPlusRunning = msg.eRTPlusRunning;
			const log = this._rtPlusLogValue(msg.eRTPlusItem1Name, msg.eRTPlusItem1, msg.eRTPlusItem2Name, msg.eRTPlusItem2);
			if (log) this.rds.log.push({ time, field: 'eRT+', value: log, freq, vfoIndex, group: msg.srcGroup });
		}
		this._applyRdsErtFields(stn, msg, time, freq, vfoIndex);
	},
	/** Apply eRT (Enhanced RadioText) complete and partial fields. */
	_applyRdsErtFields(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		if (msg.eRT !== undefined) {
			stn.eRT = msg.eRT;
			stn.eRTPartial = '';
			if (msg.eRTCharStatus) stn.eRTCharStatus = msg.eRTCharStatus;
			this.rds.log.push({ time, field: 'eRT', value: msg.eRT, freq, vfoIndex, group: msg.srcGroup });
		}
		if (msg.eRTPartial !== undefined) {
			stn.eRTPartial = msg.eRTPartial;
			if (msg.eRTCharStatus) stn.eRTCharStatus = msg.eRTCharStatus;
		}
	},
	/** Build RT+/eRT+ log value string from tag names and text. Returns null if nothing to log. */
	_rtPlusLogValue(n1: string | undefined, t1: string | undefined, n2: string | undefined, t2: string | undefined): string | null {
		if (!t1 && !t2) return null;
		const s1 = n1 ? `[${n1}] ${t1 ?? ''}` : (t1 ?? '');
		const s2 = n2 ? `[${n2}] ${t2 ?? ''}` : (t2 ?? '');
		return [s1, s2].filter(Boolean).join('  ') || null;
	},
	/** Apply EON, TMC, and paging fields. */
	_applyRdsEonPagingFields(
		this: AppInstance,
		stn: ReturnType<AppInstance['_rdsStation']>,
		msg: RDSMessage,
		time: string,
		freq: string,
		vfoIndex: number,
	) {
		if (msg.eon !== undefined) {
			const eon = msg.eon;
			const extra: string[] = [];
			if (eon.mappedFreqs?.length) extra.push(`MF:${eon.mappedFreqs.length}`);
			if (eon.ptyOn !== undefined) extra.push(`PTY:${eon.ptyOn}`);
			if (eon.pinDay) extra.push(`PIN:day${eon.pinDay} ${String(eon.pinHour).padStart(2, '0')}:${String(eon.pinMinute).padStart(2, '0')}`);
			const label = `PI:${eon.pi}${eon.ps ? ' PS:' + eon.ps.trim() : ''}${extra.length ? ' ' + extra.join(' ') : ''}`;
			this.rds.log.push({ time, field: 'EON', value: label, freq, vfoIndex, group: msg.srcGroup });
			this._applyRdsEonNetwork(stn, eon);
		}
		if (msg.tmcMessage !== undefined) this._applyRdsTmcMessage(time, freq, vfoIndex, msg.tmcMessage, msg.srcGroup);
		if (msg.paging !== undefined) {
			const p = msg.paging;
			const tag = stn.pi ? `RDS ${stn.pi}${stn.ps.trim() ? ' ' + stn.ps.trim() : ''}` : `RDS ${freq}`;
			this.rds.log.push({
				time,
				field: `PAG-${p.type === 'tone' ? 'TONE' : p.type.toUpperCase()}`,
				value: p.type === 'tone' ? p.addrFmt : `${p.addrFmt}  ${p.data}`,
				freq,
				vfoIndex,
				group: msg.srcGroup,
			});
			this.pager.log.push({
				protocol: 'rds',
				time,
				freq,
				vfoIndex,
				capcode: p.addrFmt,
				type: p.type === 'alpha' ? 'alpha' : p.type === 'tone' ? 'tone' : 'numeric',
				text: p.type === 'tone' ? '' : (p.data ?? ''),
				detectDebug: tag,
			});
			this.pager.panelOpen = true;
		}
	},
	_applyRdsEonNetwork(this: AppInstance, stn: ReturnType<AppInstance['_rdsStation']>, eon: NonNullable<RDSMessage['eon']>) {
		stn.eonNetworks[eon.pi] = {
			pi: eon.pi,
			ps: eon.ps,
			tp: eon.tp,
			ta: eon.ta,
			af: eon.af,
			mappedFreqs: eon.mappedFreqs,
			ptyOn: eon.ptyOn,
			pinDay: eon.pinDay,
			pinHour: eon.pinHour,
			pinMinute: eon.pinMinute,
			lsn: eon.lsn,
			lsIls: eon.lsIls,
			lsEg: eon.lsEg,
			lsLa: eon.lsLa,
		};
	},
	_applyRdsTmcMessage(
		this: AppInstance,
		time: string,
		freq: string,
		vfoIndex: number,
		tm: NonNullable<RDSMessage['tmcMessage']>,
		srcGroup: string | undefined,
	) {
		const text = `EVT:${tm.event} LOC:${tm.location} ${tm.direction === 'negative' ? '◄' : '►'} EXT:${tm.extent}${tm.diversion ? ' DIV' : ''}`;
		this.rds.log.push({ time, field: 'TMC', value: text, freq, vfoIndex, group: srcGroup });
		this.pager.log.push({
			protocol: 'tmc',
			time,
			freq,
			vfoIndex,
			capcode: `LOC:${tm.location}`,
			type: tm.multi ? 'multi' : 'single',
			text,
			tmcEvent: tm.event,
			tmcLocation: tm.location,
			tmcDirection: tm.direction,
			tmcExtent: tm.extent,
			tmcDuration: tm.duration,
			tmcDiversion: tm.diversion,
		});
		this.pager.panelOpen = true;
	},
	/** Region change: update decoder AND auto-set de-emphasis (NA→75µs, EU→50µs). */
	rdsFlagTitle(flag: string, value: boolean | null, a?: number, b?: number): string {
		const nl = '\n';
		if (flag === 'tp' || flag === 'ta') return this._rdsTrafficFlagTitle(flag, value, nl);
		if (flag === 'la')
			return (
				'LA - Linkage Actuator (ACTIVE)' +
				nl +
				'This transmitter is temporarily part of an extended service (e.g. a split national network merged).' +
				nl +
				'Radio behaviour: treats all transmitters in this Linkage Set as the same programme; AF retuning works across them.'
			);
		if (flag === 'tmc')
			return (
				'TMC - Traffic Message Channel' +
				(a !== undefined && a >= 0 ? ' (ID 0x' + a.toString(16).toUpperCase() + ')' : '') +
				nl +
				'Silent digital traffic data on this station (ISO 14819 ALERT-C).' +
				nl +
				'Navigation systems decode incidents, congestion and roadworks in the background without interrupting audio, and reroute automatically.'
			);
		if (flag === 'ews')
			return (
				'EWS - Emergency Warning System (channel ' +
				(a ?? '') +
				')' +
				nl +
				'Civil emergency broadcast infrastructure.' +
				nl +
				'Radio behaviour: on receiving an EWS message, immediately unmutes, raises volume to a preset level, and displays the warning regardless of what the listener is doing.'
			);
		if (flag === 'rp')
			return (
				'RP - Radio Paging (EN 50067 Annex M)' +
				nl +
				'This station carries one-way pager messages in group 7A.' +
				nl +
				'Pagers periodically wake up, check for their capcode, then sleep again to save battery.' +
				nl +
				'Network group: ' +
				(a ?? '') +
				'  Battery-save sync slot: ' +
				(b ?? '')
			);
		if (flag === 'epp')
			return (
				'EPP - Enhanced Radio Paging (EN 50067 Annex M)' +
				nl +
				'Extended paging with a larger address space and more message types than basic RP.' +
				nl +
				'OPC (operator code): ' +
				(a ?? '') +
				'  PAC (paging area): ' +
				(b === 0 ? (b ?? '') + ' (all areas)' : (b ?? ''))
			);
		return flag.toUpperCase();
	},
	_rdsTrafficFlagTitle(flag: string, value: boolean | null, nl: string): string {
		if (flag === 'tp') {
			if (value === null) return 'TP - Traffic Programme: not yet received';
			if (value)
				return (
					'TP - Traffic Programme (ON)' +
					nl +
					'This station regularly broadcasts road traffic bulletins.' +
					nl +
					'Radio behaviour: stores it in the TP list; when TA fires, auto-unmutes here. If signal drops, retunes via AF list or switches to a linked EON network with TA active.'
				);
			return (
				'TP - Traffic Programme (OFF)' +
				nl +
				'This station does not carry traffic bulletins.' +
				nl +
				'Radio behaviour: skips it when scanning for traffic stations. Will not auto-switch here for traffic.'
			);
		}
		if (value === null) return 'TA - Traffic Announcement: not yet received';
		if (value)
			return (
				'TA - Traffic Announcement (ACTIVE)' +
				nl +
				'A traffic bulletin is on air on THIS station right now.' +
				nl +
				'Radio behaviour: unmutes from standby and switches HERE. Returns to previous station/volume once TA clears.'
			);
		return (
			'TA - Traffic Announcement (inactive)' +
			nl +
			'No traffic bulletin is currently airing on this station.' +
			nl +
			'Radio behaviour: waiting. Will unmute and switch here when TA becomes active.'
		);
	},
	setRdsRegion(this: AppInstance, vfoIndex: number, region: string) {
		const vfo = this.vfos[vfoIndex];
		if (!vfo) return;
		const normalized = region === 'na' ? 'na' : 'eu';
		vfo.rdsRegion = normalized;
		// Auto-set de-emphasis: NA/RBDS uses 75µs, EU/RDS uses 50µs
		if (normalized === 'na') vfo.deEmphasis = '75us';
		else vfo.deEmphasis = '50us';
		this.updateBackendVfoParams(vfoIndex);
	},
	clearRds(this: AppInstance) {
		this.rds.log = [];
		this.rds.stations = {};
	},
	_onRdsStatus(this: AppInstance, vfoIndex: number, _freqMhz: number, status: RdsStatus) {
		this.rdsStatus[vfoIndex] = status;
	},
	exportRds(this: AppInstance) {
		const lines = this.rds.log.map((e) => `[${e.time}] ${e.freq}  ${e.field}: ${e.value}`);
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `rds-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
