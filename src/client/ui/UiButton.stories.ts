import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import UiButton, { buttonVariants } from './UiButton';

const meta = {
	title: 'UI/Button', component: UiButton, tags: ['autodocs'],
	args: { variant: 'default', disabled: false, onClick: fn() },
	argTypes: { variant: { control: 'select', options: Object.keys(buttonVariants) } },
	render: args => ({ components: { UiButton }, setup: () => ({ args }), template: '<UiButton v-bind="args">Add SDR</UiButton>' }),
} satisfies Meta<typeof UiButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Primary: Story = { args: { variant: 'primary' } };
export const Secondary: Story = { args: { variant: 'secondary' } };
export const Disabled: Story = { args: { disabled: true }, play: async ({ canvasElement }) => { await expect(within(canvasElement).getByRole('button')).toBeDisabled(); } };
export const ActiveIcon: Story = { render: () => ({ components: { UiButton }, template: '<UiButton variant="icon" class="active" title="DSP Stats" aria-pressed="true"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 3H5v18h14V3zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg></UiButton>' }) };
export const AllVariants: Story = {
	render: () => ({
		components: { UiButton },
		setup: () => ({
			variants: Object.keys(buttonVariants),
			icons: ['icon', 'copy', 'bookmark', 'jump', 'edit', 'delete', 'io', 'vfo-remove', 'vfo-mute', 'solo', 'search-clear'],
		}),
		template: `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px">
			<div v-for="variant in variants" :key="variant" style="min-height:100px;padding:14px;border:1px solid var(--border);border-radius:6px;background:var(--bg-panel)">
				<div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">{{ variant }}</div>
				<div style="display:flex;align-items:center;min-height:32px">
					<UiButton :variant="variant" :title="variant" :aria-label="variant">
						<svg v-if="icons.includes(variant)" viewBox="0 0 24 24" :width="variant === 'icon' ? 24 : 12" :height="variant === 'icon' ? 24 : 12" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
						<template v-else>{{ variant === 'auto-squelch' ? 'Auto' : variant.startsWith('import-') ? 'Import' : variant === 'device' ? 'HackRF One' : 'Action' }}</template>
					</UiButton>
				</div>
			</div>
		</div>`,
	}),
};
export const Click: Story = {
	play: async ({ canvasElement, args }) => { await userEvent.click(within(canvasElement).getByRole('button')); await expect(args.onClick).toHaveBeenCalledOnce(); },
};
