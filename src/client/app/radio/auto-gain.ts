import { receiverOverloaded } from '@/radio/auto-gain-level';
import { errorMessage } from '@/platform/errors';
import type { AppInstance } from '@/app/core/receiver.types';
import { nextLimeGain } from '@/radio/lime-auto-gain';
import type { LimeGains, HackRFGains, DeviceCapabilities, RxLevel, AutoGainMode } from '@/radio/types';
import { nextHackRFGain } from '@/radio/hackrf-auto-gain';

const gainOptions = [
	{
		label: 'Auto set gains',
		items: [
			{ id: 'balanced', label: 'Balanced', icon: 'radio' as const, description: 'Everyday reception with room for peaks' },
			{ id: 'sensitivity', label: 'Weak signals', icon: 'radio' as const, description: 'Favor early amplification for distant signals' },
			{ id: 'strong', label: 'Strong signals', icon: 'radio' as const, description: 'Reduce early gain and leave extra headroom' },
		],
	},
];

export const autoGainMethods = {
	autoGainOptions() {
		return gainOptions;
	},
	autoGainSupported(this: AppInstance) {
		return this.gains['Receive Mode'] !== 1 && ['limesdr', 'hackrf'].includes(this.deviceCapabilities?.deviceType ?? '');
	},
	autoGainControls(this: AppInstance) {
		return this.deviceCapabilities?.deviceType === 'hackrf' ? 'LNA, VGA and RF amplifier' : 'LNA, TIA and PGA';
	},
	cancelAutoGain(this: AppInstance) {
		this.autoGain.cancelled = true;
		this.autoGain.status = 'Finishing…';
	},
	async autoSetGains(this: AppInstance, mode: AutoGainMode = 'balanced') {
		if (!canAdjustGains(this)) return;
		const isHackrf = this.deviceCapabilities?.deviceType === 'hackrf';
		const names = isHackrf ? ['Amp (14dB)', 'LNA', 'VGA'] : ['LNA', 'TIA', 'PGA'];
		const original: Record<string, number> = Object.fromEntries(names.map((name) => [name, this.gains[name]]));
		let applied = { ...original };
		const capabilities = this.deviceCapabilities;
		const valid = createAutoGainGuard.call(this, capabilities);
		this.autoGain.active = true;
		this.autoGain.mode = mode;
		this.autoGain.cancelled = false;
		this.autoGain.level = null;
		this.autoGain.status = 'Measuring receiver level…';
		const measure = createLevelMeasurement.call(this, valid);
		try {
			// Allow any pending manual gain command to finish before sampling.
			await this.backend.setGains(original);
			let after = Date.now() + 150;
			let stable = 0;
			let allowAmp = true;
			const maxSteps = isHackrf ? 40 : 14;
			for (let step = 0; step < maxSteps; step++) {
				const level = await measure(after);
				this.autoGain.level = level;
				if (receiverOverloaded(level)) allowAmp = false;
				const next = isHackrf
					? nextHackRFGain(applied as HackRFGains, level, mode, allowAmp)
					: nextLimeGain(applied as LimeGains, level, mode);
				const nextGains = next.gains as Record<string, number>;
				this.autoGain.status = next.reason;
				if (next.done) {
					if (++stable >= 2) break;
					after = level.timestamp;
					continue;
				}
				stable = 0;
				await applyGainChanges.call(this, names, nextGains, applied, valid);
				after = Date.now() + 150;
				if (step === maxSteps - 1) {
					this.autoGain.level = await measure(after);
					this.autoGain.status = 'Adjustment limit reached; review levels';
				}
			}
		} catch (error) {
			this.autoGain.status = error instanceof Error ? errorMessage(error) : String(error);
			if (!this.autoGain.cancelled && valid()) {
				// Restore reductions first as well, especially when changing the RF amp.
				const restore = Object.fromEntries(
					[...names.filter((name) => original[name] < applied[name]), ...names.filter((name) => original[name] >= applied[name])].map(
						(name) => [name, original[name]],
					),
				);
				try {
					await this.backend.setGains(restore);
					applied = original;
				} catch {
					this.autoGain.status += ' · Could not restore original gains';
				}
			}
		} finally {
			if (this.deviceCapabilities === capabilities) Object.assign(this.gains, applied);
			// Keep the manual gain watcher suppressed through the reactive update.
			await this.$nextTick();
			this.autoGain.active = false;
			this.saveSetting();
			if (this.remoteMode === 'host' && this._webrtc) this._webrtc.sendCommand({ type: 'sync', gains: this.gains, locks: this.locks });
		}
	},
};

function createLevelMeasurement(this: AppInstance, valid: () => boolean) {
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const measure = async (after: number): Promise<RxLevel> => {
		for (let poll = 0; poll < 25; poll++) {
			if (this.autoGain.cancelled || !valid()) throw new Error('Adjustment cancelled');
			await wait(100);
			const level = await this.backend.getRxLevel();
			if (this.autoGain.cancelled || !valid()) throw new Error('Adjustment cancelled');
			if (level && level.started >= after && Date.now() - level.timestamp < 1000) return level;
		}
		throw new Error('No fresh receiver samples; check the USB stream');
	};
	return measure;
}

function createAutoGainGuard(this: AppInstance, capabilities: DeviceCapabilities | null) {
	const config = () =>
		JSON.stringify([this.radio.centerFreq, this.radio.sampleRate, this.radio.frequencyShift, this.gains['RX Channel'], this.gains.Antenna]);
	const initial = config();
	const valid = () =>
		this.running && this.connected && this.deviceCapabilities === capabilities && this.remoteMode !== 'client' && config() === initial;
	return valid;
}

async function applyGainChanges(
	this: AppInstance,
	names: string[],
	nextGains: Record<string, number>,
	applied: Record<string, number>,
	valid: () => boolean,
) {
	// Apply reductions before increases to avoid transient overload.
	for (const name of [
		...names.filter((name) => nextGains[name] < applied[name]),
		...names.filter((name) => nextGains[name] > applied[name]),
	]) {
		if (this.autoGain.cancelled || !valid()) throw new Error('Adjustment cancelled');
		await this.backend.setGain(name, nextGains[name]);
		applied[name] = nextGains[name];
	}
}

function canAdjustGains(app: AppInstance): boolean {
	return !app.autoGain.active && app.running && app.connected && app.remoteMode !== 'client' && app.autoGainSupported();
}
