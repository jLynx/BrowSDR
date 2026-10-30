/** Observed NZ plans, in transmission order. Frequencies are receiver measurements. */
export const RTK_HOP_PLANS = {
	rtk2: {
		frequencies: [9, 15, 4, 10, 16, 5, 11, 17, 0, 6, 12, 1, 7, 13, 2, 8, 14, 3].map((slot) => 915491000 + slot * 700000),
		dwell: 1,
		guard: 0.06,
	},
	rtk3: {
		frequencies: Array.from({ length: 25 }, (_, slot) => 915401000 + slot * 500000),
		dwell: 0.6,
		guard: 0.02,
	},
};
