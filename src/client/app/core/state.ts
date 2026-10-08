import type { DspStats } from '@/remote/types';
import type { Remote } from 'comlink';
import type { Backend } from '@/worker/runtime/backend';
import type { DeviceCapabilities } from '@/radio/sdr-device';
import type { Bookmark, Vfo } from './types';
import { makeDefaultVfo, BOOKMARK_CATEGORIES } from './constants';
import type { DSDStatus } from '@/worker/decoders/dsd/types';
import type { CapabilityIssue } from '@/platform/browser-capabilities';
import type { RxLevel } from '@/radio/sdr-device';
import type { Rtl433Status, Rtl433Protocol } from '@/worker/decoders/rtl433';

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
		remoteClients: [] as Array<{
			id: string;
			deviceId?: string;
			connectedAt: number;
			country: string;
			vfoCount: number;
			firstFreq: number | null;
			isRelay: boolean;
		}>,
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
			fftSize: 65536,
		},
		display: {
			spectrumFps: 20,
			sharedChannelization: true,
			minDB: -70.0,
			maxDB: 0.0,
		},
		gains: {} as Record<string, number>,
		autoGain: { active: false, cancelled: false, status: '', level: null as RxLevel | null },
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
		showStats: false,
		toolsCompact: true,
		toolsMenuOpen: false,
		fps: 0,
		vfoSquelchOpen: [] as boolean[],
		vfoSquelchHangUntil: [] as number[],
		vfoActivityStats: [] as Array<{ count: number; totalMs: number; squelchOpenSince: number | null }>,
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
			devices: [] as Array<{ device: USBDevice; driverName: string; productName: string }>,
		},
		sidebarOpen: false,
		showAbout: false,
		collapsedPanels: {} as Record<string, boolean>,
		vfoConflictDialog: {
			show: false,
			vfoIndex: -1,
			requestedFreq: 0,
			previousFreq: 0,
			optionA: null as { centerFreq: number; description: string } | null,
			optionB: null as { centerFreq: number; description: string; excludedVfos: number[] } | null,
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
			log: [] as Array<{
				time: string;
				freq: string;
				text: string;
				duration: string;
				transcribeTime?: string;
				vfoIndex?: number | null;
				model?: string;
			}>,
			statusMsg: '',
			recording: false,
			transcribing: false,
			recordStart: null as Date | null,
			recordDuration: 0,
			pendingChunks: 0,
		},
		pocsag: {
			panelOpen: false,
			log: [] as Array<{ time: string; freq: string; vfoIndex: number; capcode: string; type: string; text: string; baud: number }>,
		},
		dsdStatus: [] as Array<DSDStatus | null>,
		rtl433: {
			panelOpen: false,
			status: [] as Array<Rtl433Status | null>,
			protocols: [] as Rtl433Protocol[],
			log: [] as Array<{ time: string; freq: string; vfoIndex: number; event: Record<string, unknown> }>,
			filter: '',
			showProtocols: false,
		},
		rds: {
			panelOpen: false,
			stations: {} as Record<
				number,
				{ ps: string; rt: string; pi: string; pty: number; ptyLabel: string; tp: boolean; ta: boolean; freq: string }
			>,
			log: [] as Array<{ time: string; field: string; value: string; freq: string; vfoIndex: number }>,
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
