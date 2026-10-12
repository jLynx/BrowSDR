import { defineComponent, onBeforeUnmount, onMounted, ref } from 'vue';
import { UiButton } from '@/ui';
import { saveOfflineDatabase } from './database/offline';
import { offlineSnapshotState, snapshotManifest } from './database/snapshot';
import type { OfflineSnapshotState } from './database/types';

export default defineComponent({
	name: 'AdsbCacheControl',
	components: { UiButton },
	template: `<div class="adsb-cache-control">
		<UiButton v-if="state && (state !== 'current' || busy)" variant="transcript" :disabled="busy" @click="save">{{ state === 'update' ? 'Update offline database' : 'Save offline database' }}{{ size }}</UiButton>
		<span v-if="status" role="status">{{ status }}</span>
	</div>`,
	setup() {
		const state = ref<OfflineSnapshotState>();
		const busy = ref(false);
		const status = ref('');
		const size = ref('');
		let mounted = true;
		let checking = false;
		const check = async () => {
			if (busy.value || checking) return;
			checking = true;
			try {
				const value = await offlineSnapshotState(true);
				const manifest = await snapshotManifest();
				if (mounted) {
					state.value = value;
					size.value = manifest
						? ` (~${Math.ceil(Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0) / 1000000)} MB)`
						: '';
				}
			} finally {
				checking = false;
			}
		};
		const recheck = () => {
			void check();
		};
		onMounted(() => {
			recheck();
			window.addEventListener('online', recheck);
		});
		onBeforeUnmount(() => {
			mounted = false;
			window.removeEventListener('online', recheck);
		});
		const save = async () => {
			busy.value = true;
			try {
				await saveOfflineDatabase((value) => {
					status.value = value;
				});
				state.value = await offlineSnapshotState();
				status.value = '';
			} catch {
				status.value = 'Could not save the offline database. Check your connection and available browser storage, then retry.';
			} finally {
				busy.value = false;
			}
		};
		return { state, busy, status, size, save };
	},
});
