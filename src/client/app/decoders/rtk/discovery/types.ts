import type { makeDefaultVfo } from '@/app/core/constants';
export type DiscoveryVfo = ReturnType<typeof makeDefaultVfo>;
export type Scout = { key: string; attempted: Set<string> };
export type Followers = { queue: Promise<void>; scouts: WeakMap<DiscoveryVfo, Scout> };
