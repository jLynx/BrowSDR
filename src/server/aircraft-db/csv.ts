/** Parse CSV incrementally, including quoted commas, escaped quotes and newlines. */
export class CsvReader {
	private row: string[] = [];
	private value = '';
	private quoted = false;
	private pendingQuote = false;
	private carriageReturn = false;
	private quote = '"';
	private detectQuote: boolean;

	constructor(
		private readonly receive: (row: string[]) => void,
		quote: '"' | "'" | 'auto' = '"',
	) {
		this.detectQuote = quote === 'auto';
		if (!this.detectQuote) this.quote = quote;
	}

	write(text: string) {
		for (const character of text) this.character(character);
	}

	finish() {
		if (this.quoted && !this.pendingQuote) throw new Error('Unterminated CSV field');
		if (this.value || this.row.length) this.endRow();
	}

	private character(character: string) {
		if (this.detectQuote && character.trim()) {
			this.quote = character === "'" ? "'" : '"';
			this.detectQuote = false;
		}
		if (this.carriageReturn) {
			this.carriageReturn = false;
			if (character === '\n') return;
		}
		if (this.quoted) {
			if (!this.pendingQuote) {
				if (character === this.quote) this.pendingQuote = true;
				else this.value += character;
				return;
			}
			this.pendingQuote = false;
			if (character === this.quote) {
				this.value += character;
				return;
			}
			this.quoted = false;
		}
		if (character === this.quote && !this.value.trim()) {
			this.value = '';
			this.quoted = true;
		} else if (character === ',') {
			this.row.push(this.value);
			this.value = '';
		} else if (character === '\n' || character === '\r') {
			this.endRow();
			this.carriageReturn = character === '\r';
		} else this.value += character;
		if (this.value.length > 65536 || this.row.length > 128) throw new Error('CSV row exceeds safety limit');
	}

	private endRow() {
		this.row.push(this.value);
		this.receive(this.row);
		this.row = [];
		this.value = '';
	}
}
