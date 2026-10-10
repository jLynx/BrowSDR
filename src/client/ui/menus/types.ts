import type { UiIconName } from '@/ui/indicators/icons.types';

export interface UiMenuItem {
	id: string;
	label: string;
	description?: string;
	icon: UiIconName;
	active?: boolean;
	open?: boolean;
}

export interface UiMenuGroup {
	label: string;
	items: UiMenuItem[];
}
