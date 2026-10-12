import type { Preview } from '@storybook/vue3-vite';
import '@/style.css';
import './preview.css';

const preview: Preview = {
	parameters: { layout: 'padded', controls: { expanded: true } },
};
export default preview;
