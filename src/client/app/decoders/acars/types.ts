export interface AcarsField {
	label: string;
	value: string;
}

export interface AcarsInterpretation {
	title: string;
	summary: string;
	coverage: 'decoded' | 'partial' | 'unknown';
	fields: AcarsField[];
	notes: string[];
}
