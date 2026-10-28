export interface IqCaptureWindow extends Window {
	showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
}
