import { defineComponent } from 'vue';
import template from '../../../src/client/app/receiver.html?raw';
import VfoPanel from '../../../src/client/app/vfo-panel';
import * as components from '../../../src/client/ui';
import { createAppData } from '../../../src/client/app/state';
import { computedProperties } from '../../../src/client/app/computed';
import { uiHelperMethods } from '../../../src/client/app/ui-helpers';
import { autoGainMethods } from '../../../src/client/app/auto-gain';
import { rdsMethods } from '../../../src/client/app/rds';
import { rtl433Methods } from '../../../src/client/app/rtl433';
import { bookmarkMethods } from '../../../src/client/app/bookmarks';
import { zoomMethods } from '../../../src/client/app/zoom';
import { audioMethods } from '../../../src/client/app/audio';
import { whisperMethods } from '../../../src/client/app/whisper';
import { pocsagMethods } from '../../../src/client/app/pocsag';
import { vfoMethods } from '../../../src/client/app/vfo';
import { connectionMethods } from '../../../src/client/app/connection';
import { remoteMethods } from '../../../src/client/app/remote';

export const ReceiverView = defineComponent({
	template, components: { ...components, VfoPanel },
	provide() { return { receiver: this }; },
	data: () => ({ ...createAppData(), receiverId: 'test-receiver', workspace: null }),
	computed: computedProperties,
	methods: {
		...uiHelperMethods, ...autoGainMethods, ...rdsMethods, ...rtl433Methods, ...bookmarkMethods,
		...zoomMethods, ...audioMethods, ...whisperMethods, ...pocsagMethods, ...vfoMethods, ...connectionMethods, ...remoteMethods,
		isFreqInBandwidth: () => true,
	},
});
