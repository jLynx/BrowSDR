import BlePanel from '@/app/decoders/ble/panel';
import { bleMethods } from '@/app/decoders/ble/controller';
import AcarsPanel from '@/app/decoders/acars/panel';
import { acarsMethods } from '@/app/decoders/acars';
import AisPanel from '@/app/decoders/ais/panel';
import RadiosondePanel from '@/app/decoders/radiosonde/panel';
import { radiosondeMethods } from '@/app/decoders/radiosonde/controller';
import { aisMethods } from '@/app/decoders/ais';
import { defineComponent } from 'vue';
import template from '@/app/templates/receiver';
import VfoPanel from '@/app/radio/vfo-panel';
import RxLevel from '@/app/radio/rx-level';
import GainReset from '@/app/radio/gain-settings';
import ContrastControls from '@/app/display/contrast-controls';
import * as components from '@/ui';
import { createAppData } from '@/app/core/state';
import { computedProperties } from '@/app/core/computed';
import { uiHelperMethods, watchVfoSelection } from '@/app/core/ui-helpers';
import { autoGainMethods } from '@/app/radio/auto-gain';
import { rdsMethods } from '@/app/decoders/rds';
import AdsbPanel from '@/app/decoders/adsb/panel';
import { adsbMethods } from '@/app/decoders/adsb';
import { rtl433Methods } from '@/app/decoders/rtl433';
import { bookmarkMethods } from '@/app/workspace/bookmarks';
import { zoomMethods } from '@/app/display/zoom';
import { audioMethods } from '@/app/audio/audio';
import { whisperMethods } from '@/app/decoders/whisper';
import { pagerMethods } from '@/app/decoders/pager';
import { pocsagMethods } from '@/app/decoders/pocsag';
import { gscMethods } from '@/app/decoders/gsc';
import { flexMethods } from '@/app/decoders/flex';
import { vfoMethods } from '@/app/radio/vfo';
import { connectionMethods } from '@/app/radio/connection';
import { remoteMethods } from '@/app/workspace/remote';
import HeaderTools from '@/app/workspace/receiver-tools';
import DiscoveryPanel from '@/app/discovery/panel';

export const ReceiverView = defineComponent({
	template,
	components: {
		...components,
		VfoPanel,
		RxLevel,
		GainReset,
		ContrastControls,
		AdsbPanel,
		AisPanel,
		RadiosondePanel,
		BlePanel,
		AcarsPanel,
		HeaderTools,
		DiscoveryPanel,
	},
	provide() {
		return { receiver: this };
	},
	data: () => ({ ...createAppData(), receiverId: 'test-receiver', workspace: null }),
	computed: computedProperties,
	mounted() {
		watchVfoSelection.call(this);
	},
	methods: {
		...uiHelperMethods,
		...autoGainMethods,
		...rdsMethods,
		...rtl433Methods,
		...adsbMethods,
		...aisMethods,
		...radiosondeMethods,
		...bleMethods,
		...acarsMethods,
		...bookmarkMethods,
		...zoomMethods,
		...audioMethods,
		...whisperMethods,
		...pagerMethods,
		...pocsagMethods,
		...gscMethods,
		...flexMethods,
		...vfoMethods,
		...connectionMethods,
		...remoteMethods,
		isFreqInBandwidth: () => true,
	},
});
