export interface ViewState {
	autoLockDisabled: boolean;
	zoomScale: number;
	zoomOffset: number;
	locked: boolean;
}

export interface DisplayState {
	spectrumFps: number;
	sharedChannelization: boolean;
	minDB: number;
	maxDB: number;
}
