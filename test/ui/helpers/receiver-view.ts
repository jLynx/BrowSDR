import { defineComponent } from 'vue';
import template from '@/app/templates/receiver';
import VfoPanel from '@/app/radio/vfo-panel';
import * as components from '@/ui';
import { createAppData } from '@/app/core/state';
import { computedProperties } from '@/app/core/computed';
import { uiHelperMethods } from '@/app/core/ui-helpers';
import { autoGainMethods } from '@/app/radio/auto-gain';
import { rdsMethods } from '@/app/decoders/rds';
import { rtl433Methods } from '@/app/decoders/rtl433';
import { bookmarkMethods } from '@/app/workspace/bookmarks';
import { zoomMethods } from '@/app/display/zoom';
import { audioMethods } from '@/app/audio/audio';
import { whisperMethods } from '@/app/decoders/whisper';
import { pocsagMethods } from '@/app/decoders/pocsag';
import { vfoMethods } from '@/app/radio/vfo';
import { connectionMethods } from '@/app/radio/connection';
import { remoteMethods } from '@/app/workspace/remote';

export const ReceiverView = defineComponent({
	template,
	components: { ...components, VfoPanel },
	provide() {
		return { receiver: this };
	},
	data: () => ({ ...createAppData(), receiverId: 'test-receiver', workspace: null }),
	computed: computedProperties,
	methods: {
		...uiHelperMethods,
		...autoGainMethods,
		...rdsMethods,
		...rtl433Methods,
		...bookmarkMethods,
		...zoomMethods,
		...audioMethods,
		...whisperMethods,
		...pocsagMethods,
		...vfoMethods,
		...connectionMethods,
		...remoteMethods,
		isFreqInBandwidth: () => true,
	},
});
