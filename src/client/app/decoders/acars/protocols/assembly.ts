import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsAssembly, AcarsAssemblyResult } from './types';

/** Reassembles only consecutive downlink blocks within one receiver/VFO log. */
export function assembleAcars(records: readonly AcarsRecord[]): AcarsAssemblyResult {
	const pending = new Map<string, AcarsAssembly>();
	const completed = new Map<number, AcarsAssembly>();
	const failures = new Map<number, string>();
	const failedChains = new Map<string, string>();
	for (const message of records) {
		const number = /^([A-Z0-9]{3})([A-Z])$/.exec(message.messageNumber ?? '');
		if (!number || message.direction !== 'downlink' || !message.registration) continue;
		const key = `${message.registration}\0${message.mode}\0${message.label}\0${number[1]}`;
		const chain = pending.get(key);
		if (chain && sameBlock(chain.last, message)) {
			// A retransmitted payload can carry a newer transport block ID. Keep its latest envelope.
			if (validRetransmission(chain, message)) chain.last = message;
			continue;
		}
		if (number[2] === 'A') {
			pending.delete(key);
			failedChains.delete(key);
			if (message.continuation) pending.set(key, { first: message, last: message, text: message.text, blocks: [message.messageNumber!] });
			continue;
		}
		const mismatch = chain
			? incompatibility(chain, message)
			: (failedChains.get(key) ?? 'No matching initial ETB block A is available in this VFO log.');
		if (mismatch) {
			failures.set(message.id, mismatch);
			failedChains.set(key, mismatch);
			pending.delete(key);
			continue;
		}
		const active = chain!;
		const suffix = fragmentSuffix(active.first.text, message.text, message.label);
		if (suffix === undefined || active.text.length + suffix.length > 8192 || active.blocks.length >= 26) {
			const reason =
				suffix === undefined ? 'H1 application prefixes do not match.' : 'The assembled message exceeds its size or block limit.';
			failures.set(message.id, reason);
			failedChains.set(key, reason);
			pending.delete(key);
			continue;
		}
		active.text += suffix;
		active.last = message;
		active.blocks.push(message.messageNumber!);
		if (!message.continuation) {
			completed.set(message.id, active);
			pending.delete(key);
		}
	}
	return { completed, failures };
}

function sameBlock(previous: AcarsRecord, message: AcarsRecord): boolean {
	return (
		message.messageNumber === previous.messageNumber && message.text === previous.text && message.continuation === previous.continuation
	);
}

function validRetransmission(chain: AcarsAssembly, message: AcarsRecord): boolean {
	const gap = message.receivedAt - chain.last.receivedAt;
	return (
		gap >= 0 &&
		gap <= 120_000 &&
		message.receivedAt - chain.first.receivedAt <= 300_000 &&
		(!chain.first.flight || !message.flight || chain.first.flight === message.flight)
	);
}

function incompatibility(chain: AcarsAssembly, message: AcarsRecord): string | undefined {
	const gap = message.receivedAt - chain.last.receivedAt;
	const elapsed = message.receivedAt - chain.first.receivedAt;
	const nextLetter = String.fromCharCode(chain.last.messageNumber!.charCodeAt(3) + 1);
	if (gap < 0 || gap > 120_000 || elapsed > 300_000) return 'The block sequence exceeds the reassembly time window.';
	if (message.messageNumber?.[3] !== nextLetter)
		return `Expected message block ${chain.last.messageNumber!.slice(0, 3)}${nextLetter}; received ${message.messageNumber}.`;
	if (chain.first.flight && message.flight && chain.first.flight !== message.flight) return 'Flight identifiers conflict between blocks.';
	// Numeric block IDs sequence the aircraft's transport, including unrelated messages.
	// The message-number suffix sequences this payload (as in libacars downlink reassembly).
}

function fragmentSuffix(first: string, next: string, label: string): string | undefined {
	if (label !== 'H1') return next;
	const prefix = /^#[A-Z0-9]{2}B(?:\/[A-Z0-9]{2} )?/.exec(first)?.[0];
	const repeated = /^#[A-Z0-9]{2}B(?:\/[A-Z0-9]{2} )?/.exec(next)?.[0];
	if (!prefix && !repeated) return next;
	if (prefix !== repeated) return;
	return next.slice(repeated!.length);
}
