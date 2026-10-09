import part0 from './shell.html?raw';
import part1 from './transcription.html?raw';
import part2 from './pocsag.html?raw';
import part3 from './rtl433.html?raw';
import part4 from './rds.html?raw';
import part5 from './activity.html?raw';
import part6 from './bookmarks.html?raw';
import part7 from './remote-clients.html?raw';
import part8 from './device-picker.html?raw';
import part9 from './remote-connect.html?raw';
import part10 from './about.html?raw';
import part11 from './vfo-conflict.html?raw';

export default [
	part0,
	part1,
	part2,
	part3,
	'<AdsbPanel /><AisPanel /><BlePanel />',
	part4,
	part5,
	part6,
	part7,
	part8,
	part9,
	part10,
	part11,
].join('');
