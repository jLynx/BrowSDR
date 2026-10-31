import type { LoraProfile, RtkProfile, RtkProfileMode } from '@/worker/decoders/rtk/types';

export function physicalProfile(profile?: RtkProfileMode): RtkProfile {
	return profile === 'auto' || profile === 'scan' ? 'rtk1' : (profile ?? 'rtk1');
}

export const RTK_RATE = 1000000;
export const RTK_PROFILES: Record<RtkProfile, LoraProfile> = {
	rtk1: { bandwidth: 500000, oversample: 2, sync: [40, 36], ldro: true },
	rtk2: { bandwidth: 250000, oversample: 4, sync: [16, 8], alternateSync: [8, 16], ldro: false },
	rtk3: { bandwidth: 250000, oversample: 4, sync: [8, 16], ldro: false },
};
export const profileName: Record<RtkProfile, string> = {
	rtk1: 'Mammotion RTK1 profile',
	rtk2: 'Mammotion RTK2 profile',
	rtk3: 'Mammotion RTK3 experimental profile',
};
export const timingPpm: Record<RtkProfile, number> = { rtk1: 20, rtk2: 10, rtk3: 0 };
