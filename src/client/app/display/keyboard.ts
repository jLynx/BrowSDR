import type { AppInstance } from '@/app/core/receiver.types';
import { cycleIndividualBookmark } from '@/app/workspace/bookmark-navigation';
import { errorMessage } from '@/platform/errors';
import { zoomSpectrum } from './zoom';

/** The selected receiver handles shortcuts unless a control owns the keyboard. */
export function mountSpectrumKeyboard(receiver: AppInstance): () => void {
	const keyboard = (event: KeyboardEvent) => {
		if (!canNavigate(receiver, event)) return;
		switch (event.key) {
			case 'ArrowLeft':
			case 'ArrowRight':
				event.preventDefault();
				tuneVfoStep(receiver, event.key === 'ArrowRight' ? 1 : -1);
				break;
			case 'ArrowUp':
			case 'ArrowDown':
				event.preventDefault();
				zoomSpectrum(receiver, event.key === 'ArrowUp' ? 1 : -1, 0.5);
				break;
			case '[':
			case ']':
				event.preventDefault();
				if (!event.repeat) {
					if (!receiver.autoGain.active) {
						cycleIndividualBookmark(receiver, event.key === '[' ? -1 : 1).catch((error: unknown) => receiver.showMsg(errorMessage(error)));
					}
				}
		}
	};
	document.addEventListener('keydown', keyboard);
	return () => document.removeEventListener('keydown', keyboard);
}

function canNavigate(receiver: AppInstance, event: KeyboardEvent): boolean {
	if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
	if (receiver._disposed) return false;
	if (receiver.workspace && receiver.workspace.selectedId !== receiver.receiverId) return false;
	const target = event.target instanceof Element ? event.target : document.activeElement;
	if (
		target?.closest(
			'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="spinbutton"], [role="combobox"], .ui-menu',
		)
	)
		return false;
	return !receiver.$el.querySelector('[aria-modal="true"], dialog[open]') && !document.querySelector('.keyboard-shortcuts-dialog');
}

function tuneVfoStep(receiver: AppInstance, direction: -1 | 1): void {
	const vfo = receiver.vfos[receiver.activeVfoIndex];
	if (!vfo || receiver.autoGain.active) return;
	const step = Number.isFinite(vfo.snapInterval) && vfo.snapInterval > 0 ? vfo.snapInterval : 1000;
	const frequency = Number((vfo.freq + (direction * step) / 1e6).toFixed(6));
	if (receiver.iqReplay && !receiver.isFreqInBandwidth(frequency)) {
		receiver.showMsg('Frequency is outside the recorded bandwidth');
		return;
	}
	const previous = vfo.freq;
	receiver.validateAndApplyVfoFreq(receiver.activeVfoIndex, frequency);
	if (vfo.freq !== previous && (vfo.freq < receiver.minFreq || vfo.freq > receiver.maxFreq)) {
		const position = ((vfo.freq - receiver.radio.centerFreq) * 1e6) / receiver.radio.sampleRate + 0.5;
		receiver.view.zoomOffset = position - 0.5 / receiver.view.zoomScale;
		receiver.applyZoomToEngine();
	}
}
