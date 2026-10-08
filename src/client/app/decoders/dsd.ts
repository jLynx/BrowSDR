import type { DSDStatus } from '../../worker/decoders/dsd/types';
/*
 * DSD (Digital Speech Decoder) UI methods for the Vue app.
 */

import type { AppInstance } from '../core/types';

export const dsdMethods = {
	_onDsdStatus(this: AppInstance, vfoIndex: number, status: DSDStatus) {
		if (!this.dsdStatus) this.dsdStatus = [];
		this.dsdStatus[vfoIndex] = status;
	},
};
