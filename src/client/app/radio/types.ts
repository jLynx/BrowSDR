export type PairedDevices = Array<{ device: USBDevice; driverName: string; productName: string }>;

export type PairedSdr = { device: USBDevice; driverName: string; productName: string; deviceNumber: number };
