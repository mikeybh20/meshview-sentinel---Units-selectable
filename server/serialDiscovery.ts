import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';

export interface SerialDevice {
  port: string;
  vendor: string;
  product: string;
  isLoRa: boolean;
}

// Known Meshtastic / LoRa USB vendor:product IDs
const KNOWN_LORA_IDS = new Set([
  '1a86:7523',  // CH340 (Heltec, LILYGO T-Beam)
  '10c4:ea60',  // CP210x (RAK WisBlock, some T-Beams)
  '303a:1001',  // ESP32-S3 native USB (newer boards)
  '1a86:55d4',  // CH9102 (some Heltec V3)
]);

export class SerialDiscovery extends EventEmitter {
  private currentDevice: SerialDevice | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollMs: number;

  constructor(pollMs = 3000) {
    super();
    this.pollMs = pollMs;
  }

  /** Start polling for USB serial devices */
  start() {
    console.log('[SerialDiscovery] Starting device polling...');
    this.poll(); // immediate first scan
    this.pollInterval = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  getDevice(): SerialDevice | null {
    return this.currentDevice;
  }

  private poll() {
    const devices = this.scanDevices();
    const loraDevice = devices.find(d => d.isLoRa) || devices[0] || null;

    const prevPort = this.currentDevice?.port || null;
    const newPort = loraDevice?.port || null;

    if (prevPort !== newPort) {
      this.currentDevice = loraDevice;
      if (loraDevice) {
        console.log(`[SerialDiscovery] LoRa device found: ${loraDevice.port} (${loraDevice.vendor}:${loraDevice.product})`);
        this.emit('connected', loraDevice);
      } else {
        console.log('[SerialDiscovery] LoRa device disconnected');
        this.emit('disconnected');
      }
    }
  }

  /** Scan /dev for ttyUSB* and ttyACM* devices, read sysfs for vendor/product */
  private scanDevices(): SerialDevice[] {
    const devices: SerialDevice[] = [];
    const devDir = '/dev';

    let entries: string[];
    try {
      entries = readdirSync(devDir);
    } catch {
      return devices;
    }

    const serialPorts = entries.filter(e => e.startsWith('ttyUSB') || e.startsWith('ttyACM'));

    for (const portName of serialPorts) {
      const port = join(devDir, portName);
      try {
        statSync(port); // confirm it exists
      } catch {
        continue;
      }

      const { vendor, product } = this.readUsbIds(portName);
      const usbId = `${vendor}:${product}`;
      const isLoRa = KNOWN_LORA_IDS.has(usbId);

      devices.push({ port, vendor, product, isLoRa });
    }

    return devices;
  }

  /** Read vendor and product IDs from sysfs */
  private readUsbIds(portName: string): { vendor: string; product: string } {
    // sysfs path varies; try common locations
    const sysfsBase = `/sys/class/tty/${portName}/device/../`;
    let vendor = 'unknown';
    let product = 'unknown';

    try {
      vendor = readFileSync(join(sysfsBase, 'idVendor'), 'utf-8').trim();
    } catch { /* not available */ }

    try {
      product = readFileSync(join(sysfsBase, 'idProduct'), 'utf-8').trim();
    } catch { /* not available */ }

    return { vendor, product };
  }
}

export const serialDiscovery = new SerialDiscovery();
