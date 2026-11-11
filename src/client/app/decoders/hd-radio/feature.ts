import type { AppInstance } from '@/app/core/receiver.types';
import type { HdMessage } from '@/worker/decoders/hd-radio/types';
import { hdProgram } from '@/worker/decoders/hd-radio/types';

export const hdRadioMethods = {
	setHdRadioProgram(this: AppInstance, index: number, value: number): void {
		const vfo = this.vfos[index];
		if (!vfo) return;
		vfo.hdProgram = hdProgram(value);
		const status = this.hdRadioStatus[index];
		if (status) this.hdRadioStatus[index] = { ...status, program: vfo.hdProgram, frames: 0 };
		this._resetAudioPlayback();
		this.updateBackendVfoParams(index);
	},
	_onHdRadioMessage(this: AppInstance, index: number, frequency: number, message: HdMessage): void {
		const vfo = this.vfos[index];
		if (
			!vfo ||
			vfo.mode !== 'hdradio' ||
			vfo.freq !== frequency ||
			message.freq !== frequency ||
			hdProgram(vfo.hdProgram) !== message.status.program
		)
			return;
		this.hdRadioStatus[index] = message.status;
	},
};
