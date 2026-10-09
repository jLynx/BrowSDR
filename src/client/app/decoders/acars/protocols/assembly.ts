import type { AcarsRecord } from '@/worker/decoders/acars/types';
import type { AcarsAssembly } from './types';

/** Reassembles only consecutive downlink blocks within one receiver/VFO log. */
export function assembleAcars(records: readonly AcarsRecord[]): Map<number, AcarsAssembly> {
	const pending = new Map<string, AcarsAssembly>();
	const completed = new Map<number, AcarsAssembly>();
	for (const message of records) {
		const number = /^([A-Z0-9]{3})([A-Z])$/.exec(message.messageNumber ?? '');
		if (!number || message.direction !== 'downlink' || !message.registration) continue;
		const key = `${message.registration}\0${message.mode}\0${message.label}\0${number[1]}`;
		const chain = pending.get(key);
		if (
			chain &&
			message.messageNumber === chain.last.messageNumber &&
			message.text === chain.last.text &&
			message.continuation === chain.last.continuation
		)
			continue;
		if (number[2] === 'A') {
			pending.delete(key);
			if (message.continuation) pending.set(key, { first: message, last: message, text: message.text, blocks: [message.messageNumber!] });
			continue;
		}
		if (!chain) continue;
		if (!compatible(chain, message)) {
			pending.delete(key);
			continue;
		}
		const suffix = fragmentSuffix(chain.first.text, message.text, message.label);
		if (suffix === undefined || chain.text.length + suffix.length > 8192 || chain.blocks.length >= 26) {
			pending.delete(key);
			continue;
		}
		chain.text += suffix;
		chain.last = message;
		chain.blocks.push(message.messageNumber!);
		if (!message.continuation) {
			completed.set(message.id, chain);
			pending.delete(key);
		}
	}
	return completed;
}

function compatible(chain: AcarsAssembly, message: AcarsRecord): boolean {
	const gap = message.receivedAt - chain.last.receivedAt;
	const elapsed = message.receivedAt - chain.first.receivedAt;
	const nextLetter = String.fromCharCode(chain.last.messageNumber!.charCodeAt(3) + 1);
	const blocks = /^\d$/.test(message.blockId) && /^\d$/.test(chain.last.blockId);
	return (
		gap >= 0 &&
		gap <= 120_000 &&
		elapsed <= 300_000 &&
		message.messageNumber?.[3] === nextLetter &&
		(!chain.first.flight || !message.flight || chain.first.flight === message.flight) &&
		(!blocks || Number(message.blockId) === (Number(chain.last.blockId) + 1) % 10)
	);
}

function fragmentSuffix(first: string, next: string, label: string): string | undefined {
	if (label !== 'H1') return next;
	const prefix = /^#[A-Z0-9]{2}B(?:\/[A-Z0-9]{2} )?/.exec(first)?.[0];
	const repeated = /^#[A-Z0-9]{2}B(?:\/[A-Z0-9]{2} )?/.exec(next)?.[0];
	if (!prefix && !repeated) return next;
	if (prefix !== repeated) return;
	return next.slice(repeated!.length);
}
