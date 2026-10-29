import { errorMessage, errorName } from '@/platform/errors';

export function iqFileError(error: unknown, operation: string, filename: string, writtenBytes: number): Error {
	const detail = `${errorName(error) || 'Error'}: ${errorMessage(error)}`;
	const size = `${(writtenBytes / 1024 ** 3).toFixed(2)} GiB`;
	const message =
		operation === 'finalizing'
			? `The browser could not finalize ${filename} after writing ${size} to its temporary file. The destination is not confirmed saved. If a .crswap file remains beside it, preserve it for recovery. Try a new filename in a local folder. ${detail}`
			: `The browser failed while ${operation} ${filename} (${size} written). ${detail}`;
	const result = new Error(message);
	result.name = operation === 'finalizing' ? 'IqFileFinalizeError' : 'IqFileWriteError';
	return result;
}
