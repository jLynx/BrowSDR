import { defineComponent, inject, watch, onBeforeUnmount, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { UiButton } from '@/ui';
import { errorMessage } from '@/platform/errors';
import template from './panel.html?raw';

export default defineComponent({
	components: { UiButton },
	template,
	setup() {
		const receiver = inject<AppInstance>('receiver')!;
		const busy = ref(false);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let generation = 0;
		const poll = async (id: number) => {
			try {
				const progress = await receiver.backend.getIqReplayProgress();
				if (id !== generation || !receiver.iqReplay) return;
				if (progress) receiver.iqReplay.progress = progress;
				if (progress && ['ended', 'error'].includes(progress.state) && receiver.running && !busy.value && !receiver._playChanging)
					await receiver.togglePlay();
			} catch (error) {
				if (id === generation) receiver.showMsg('Replay status: ' + errorMessage(error));
			} finally {
				if (id === generation && receiver.iqReplay)
					timer = setTimeout(() => {
						void poll(id);
					}, 250);
			}
		};
		watch(
			() => receiver.iqReplay?.recording,
			(recording) => {
				if (timer) clearTimeout(timer);
				const id = ++generation;
				if (recording)
					timer = setTimeout(() => {
						void poll(id);
					}, 250);
			},
			{ immediate: true },
		);
		onBeforeUnmount(() => {
			generation++;
			if (timer) clearTimeout(timer);
		});
		const restart = async () => {
			busy.value = true;
			try {
				await receiver.restartIqReplay();
			} catch (error) {
				receiver.showMsg('Replay: ' + errorMessage(error));
			} finally {
				busy.value = false;
			}
		};
		return { receiver, busy, restart };
	},
});
