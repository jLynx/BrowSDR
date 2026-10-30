import type { WorkspaceInstance } from '@/app/workspace/types';
import type { AppInstance } from '@/app/core/receiver.types';
import type { IqRecording } from '@/radio/iq-replay/types';

export async function connectIqReplay(workspace: WorkspaceInstance, source: AppInstance, recording: IqRecording): Promise<void> {
	if (workspace.mode === 'client' || source._connectingDevice || source._removing) return;
	source._connectingDevice = true;
	try {
		const app = source.connected ? await workspace.newReceiver() : source;
		if (!app) return;
		await app._connectIqReplay(recording);
		if (app.connected && workspace.mode === 'host') await workspace.attachHostReceiver(app);
		workspace.broadcastReceivers();
	} finally {
		source._connectingDevice = false;
	}
}
