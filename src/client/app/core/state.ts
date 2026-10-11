import type { BleDevice, BleStatus } from '@/worker/decoders/ble/types';
import type { AisStatus, Vessel } from '@/worker/decoders/ais/types';
import type { AcarsStatus, AcarsRecord } from '@/worker/decoders/acars/types';
import type { AdsbStatus, Aircraft } from '@/worker/decoders/adsb/types';
import type { RdsLogEntry, Rtl433LogEntry, PocsagLogEntry, RdsStations } from '@/app/decoders/types';
import type { WhisperLogEntry } from '@/app/decoders/whisper.types';
import type { VfoConflictSubsetOption, VfoConflictOption, VfoActivityStats } from '@/app/core/types';
import type { PairedDevices } from '@/app/radio/types';
import type { RemoteClients, DspStats } from '@/remote/types';
import type { Remote } from 'comlink';
import type { Backend } from '@/worker/runtime/backend';
import type { DeviceCapabilities, RxLevel, AutoGainMode } from '@/radio/types';
import type { Bookmark } from '@/app/workspace/types';
import type { Vfo } from './types';
import { makeDefaultVfo, BOOKMARK_CATEGORIES } from './constants';
import type { DSDStatus } from '@/worker/decoders/dsd/types';
import type { CapabilityIssue } from '@/platform/types';
import type { Rtl433Status, Rtl433Protocol } from '@/worker/decoders/types';
import { DEFAULT_FFT_SIZE, DEFAULT_SPECTRUM_RANGE } from '@/display/spectrum-range';

export function createAppData() {
	return {
		backend: null as Remote<Backend> | null,
		usbCapabilityIssue: null as CapabilityIssue | null,
		connected: false,
		running: false,
		isOnline: navigator.onLine,
		remoteMode: 'none' as 'none' | 'host' | 'client',
		remoteStatus: '',
		remoteLink: '',
		copyLinkSuccess: false,
		copyLinkTooltip: 'Copy link',
		remoteClients: [] as RemoteClients,
		showRemoteClientsDialog: false,
		showRemoteConnectDialog: false,
		remoteConnectId: '',
		recentRemoteIds: [] as string[],
		remotePeerId: '',
		snackbar: { show: false, message: '' },
		audioUnlockPendingId: null as string | null,
		radio: {
			centerFreq: 100.0,
			frequencyShift: 0.0,
			sampleRate: 20000000,
			fftSize: DEFAULT_FFT_SIZE,
		},
		display: {
			spectrumFps: 20,
			sharedChannelization: true,
			...DEFAULT_SPECTRUM_RANGE,
		},
		gains: {} as Record<string, number>,
		gainDeviceType: '',
		autoGain: {
			mode: 'balanced' as AutoGainMode,
			active: false,
			cancelled: false,
			status: '',
			level: null as RxLevel | null,
		},
		deviceCapabilities: null as DeviceCapabilities | null,
		locks: {
			centerFreq: false,
			sampleRate: false,
		} as Record<string, boolean>,
		vfos: [makeDefaultVfo(100.0)],
		activeVfoIndex: 0,
		soloAudioVfo: null as Vfo | null,
		info: { boardName: '' },
		hoverFreqText: '',
		dspStats: null as DspStats | null,
		audioGapCount: 0,
		audioGapMs: 0,
		audioTargetMs: 20,
		audioPlaybackRate: 1,
		audioDroppedFrames: 0,
		audioPlaybackEngine: 'scheduled',
		queuedAudioSched: '0',
		showStats: false,
		showStatsDetails: false,
		radioAdvanced: false,
		displayAdvanced: false,
		fps: 0,
		vfoSquelchOpen: [] as boolean[],
		vfoSquelchHangUntil: [] as number[],
		vfoActivityStats: [] as VfoActivityStats,
		autoSquelchSamples: [] as number[][],
		autoSquelchActive: [] as boolean[],
		activityNow: 0,
		showActivity: false,
		view: {
			zoomScale: 1.0,
			zoomOffset: 0.0,
			locked: false,
			autoLockDisabled: false,
		},
		...createDecoderAndBookmarkState(),
		devicePicker: {
			show: false,
			devices: [] as PairedDevices,
		},
		sidebarOpen: false,
		showAbout: false,
		collapsedPanels: {} as Record<string, boolean>,
		vfoConflictDialog: {
			show: false,
			vfoIndex: -1,
			requestedFreq: 0,
			previousFreq: 0,
			optionA: null as VfoConflictOption,
			optionB: null as VfoConflictSubsetOption,
		},
	};
}

function createDecoderAndBookmarkState() {
	return {
		whisper: {
			benchmarkAvailable: false,
			benchmarkRunning: false,
			benchmarkMessage: '',
			benchmarkResult: null as unknown,
			panelOpen: false,
			active: false,
			status: 'idle' as string,
			device: '' as '' | 'webgpu' | 'wasm',
			backendReason: '',
			loadProgress: 0,
			loadPhase: 'downloading' as string,
			loadFile: '',
			loadFilesDone: 0,
			loadFilesTotal: 0,
			model: 'onnx-community/whisper-small',
			chunkSeconds: 10,
			log: [] as WhisperLogEntry[],
			statusMsg: '',
			recording: false,
			transcribing: false,
			recordStart: null as Date | null,
			recordDuration: 0,
			pendingChunks: 0,
		},
		pocsag: {
			panelOpen: false,
			log: [] as PocsagLogEntry[],
		},
		dsdStatus: [] as Array<DSDStatus | null>,
		ble: {
			panelOpen: false,
			tuning: false,
			scanning: false,
			scanVfo: null as Vfo | null,
			status: [] as Array<BleStatus | null>,
			devices: [] as BleDevice[],
			message: '',
		},
		acars: {
			panelOpen: false,
			status: [] as Array<AcarsStatus | null>,
			sources: [] as Array<{ freq: number; messages: AcarsRecord[] } | null>,
		},
		ais: { panelOpen: false, status: [] as Array<AisStatus | null>, sources: [] as Vessel[][] },
		adsb: { panelOpen: false, status: [] as Array<AdsbStatus | null>, sources: [] as Aircraft[][] },
		rtl433: {
			panelOpen: false,
			status: [] as Array<Rtl433Status | null>,
			protocols: [] as Rtl433Protocol[],
			log: [] as Rtl433LogEntry[],
			filter: '',
			showProtocols: false,
		},
		rds: {
			panelOpen: false,
			stations: {} as RdsStations,
			log: [] as RdsLogEntry[],
		},
		...createBookmarkState(),
	};
}

function createBookmarkState() {
	return {
		bookmarkCategories: BOOKMARK_CATEGORIES,
		bookmarkCategoryFilter: '',
		bookmarkSearch: '',
		bookmarks: [] as Bookmark[],
		bookmarkModal: { show: false, type: 'individual', name: '', category: '' },
		bookmarkImportModal: { show: false },
		bookmarkEdit: {
			show: false,
			index: -1,
			type: 'individual',
			name: '',
			category: '',
			// individual fields
			freq: 100.0,
			mode: 'nfm',
			bandwidth: 12500,
			snapInterval: 2500,
			deEmphasis: 'none',
			squelchEnabled: false,
			squelchLevel: -100,
			noiseReduction: false,
			stereo: false,
			lowPass: true,
			highPass: false,
			rds: false,
			rdsRegion: 'eu',
			volume: 50,
			// group fields
			centerFreq: 100.0,
			sampleRate: 8000000,
			vfos: [] as Vfo[],
			activeVfoIndex: 0,
		},
	};
}
