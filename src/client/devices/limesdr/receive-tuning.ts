import { LimeSDRClocks } from './clocks';
import { REG_RESET, REG_RXTSP_BYP } from './protocol';
import { receivePlan } from './receive-plan';

export abstract class LimeSDRReceiveTuning extends LimeSDRClocks {
	private receiveRateDirty = false;
	abstract setAnalogBandwidth(bandwidth: number): Promise<void>;

	protected get receiveBandwidth(): number {
		return receivePlan(this.currentFrequency, this.currentSampleRate).bandwidth;
	}

	async setReceiveFrequency(frequency: number): Promise<void> {
		const plan = receivePlan(frequency, this.currentSampleRate);
		const previous = this.currentFrequency;
		const previousOversample = this.rxOversample;
		this.sxReady = false;
		try {
			if (this.receiveRateDirty || plan.oversample !== this.rxOversample) await this.configureReceiveRate(plan);
			await this.setFrequencySXR(plan.lo);
			this.sxReady = false;
			// Both RX banks use the shared LO. Keep their digital offsets consistent.
			await this.modifyReg(REG_RESET, 1, 0, 3);
			await this.setAnalogBandwidth(plan.bandwidth);
			await this.configureReceiveNCO(plan);
			this.currentFrequency = frequency;
			this.sxReady = true;
		} catch (error) {
			this.currentFrequency = previous;
			this.rxOversample = previousOversample;
			this.receiveRateDirty = true;
			this.sxReady = false;
			throw error;
		} finally {
			await this.modifyReg(REG_RESET, 1, 0, this.rxChannel + 1);
		}
	}

	async setSampleRate(rate: number): Promise<void> {
		const plan = receivePlan(this.currentFrequency, rate);
		const previousRate = this.currentSampleRate;
		const previousOversample = this.rxOversample;
		const ready = this.sxReady;
		this.sxReady = false;
		try {
			await this.configureReceiveRate(plan);
			this.sxReady = ready;
		} catch (error) {
			this.currentSampleRate = previousRate;
			this.rxOversample = previousOversample;
			this.receiveRateDirty = true;
			throw error;
		}
	}

	protected async retuneReceiveLO(unstableBand?: number): Promise<void> {
		const frequency = this.currentFrequency;
		try {
			if (unstableBand === undefined) await this.setFrequencySXR(Math.max(30e6, frequency));
			else await this.setFrequencySXR(Math.max(30e6, frequency), unstableBand);
		} finally {
			this.currentFrequency = frequency;
		}
	}

	private async configureReceiveRate(plan: ReturnType<typeof receivePlan>): Promise<void> {
		this.currentSampleRate = plan.sampleRate;
		this.rxOversample = plan.oversample;
		try {
			await this.setCGENFrequency(plan.cgen);
			await this.modifyReg(REG_RESET, 1, 0, 3);
			await this.setAnalogBandwidth(plan.bandwidth);
			await this.configureRxTSP();
			await this.configureLML();
			await this.configureFPGAPLL();
			await this.configureReceiveNCO(plan);
			this.receiveRateDirty = false;
		} finally {
			await this.modifyReg(REG_RESET, 1, 0, this.rxChannel + 1);
		}
	}

	private async configureReceiveNCO(plan: ReturnType<typeof receivePlan>): Promise<void> {
		const enabled = plan.offset > 0;
		const word = Math.floor((plan.offset / (plan.cgen / 4)) * 2 ** 32);
		await this.writeLMS7002(0x0440, 0); // MODE_RX=frequency, SEL_RX=NCO0
		await this.writeLMS7002(0x0441, 0); // Phase offset
		await this.writeLMS7002(0x0442, Math.floor(word / 65536)); // FCW0 MSB
		await this.writeLMS7002(0x0443, word & 0xffff); // FCW0 LSB
		await this.modifyReg(REG_RXTSP_BYP, 7, 7, enabled ? 0 : 1);
		await this.modifyReg(REG_RXTSP_BYP, 15, 14, enabled ? 1 : 0);
		// LimeSuite inverts the receive mixer sign on the original mask revision.
		const originalMask = ((await this.readLMS7002(0x002f)) & 0x3f) === 0;
		await this.modifyReg(REG_RXTSP_BYP, 13, 13, enabled && originalMask ? 1 : 0);
	}
}
