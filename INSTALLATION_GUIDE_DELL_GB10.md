# Recipe: Net-AI Control Center Installation for Dell GB10 Gateway

This document provides a step-by-step procedure to deploy the Net-AI Meshtastic Control Center on a Dell GB10 Edge Gateway and connect it to your local Meshtastic network.

## System Requirements
- **Device:** Dell GB10 Edge Gateway
- **OS:** Ubuntu Server 22.04 LTS or Debian 11/12
- **Hardware Peripherals:** Meshtastic Node (attached via USB) or accessible via Network (WiFi/Ethernet)

---

## Phase 1: Gateway Preparation

### 1. Update System Packages
Ensure your gateway is up to date:
```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Install Node.js (v18+)
The control center requires Node.js. Use the NodeSource repository for the latest LTS:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Setup Serial Port Permissions
To allow the application to communicate with a Meshtastic node via USB, the user must be part of the `dialout` group:
```bash
sudo usermod -a -G dialout $USER
# Note: You may need to logout and login for this to take effect
```

---

## Phase 2: Application Installation

### 1. Clone the Project
```bash
git clone <your-repository-url>
cd meshtastic-control-center
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Create a `.env` file in the root directory:
```env
VITE_MESHTASTIC_CONNECTION_TYPE=serial
VITE_SERIAL_PORT=/dev/ttyUSB0
VITE_SERIAL_BAUD=921600
GEMINI_API_KEY=your_gemini_api_key_here
```

### 4. Build for Production
```bash
npm run build
```

---

## Phase 3: Deployment using PM2
To ensure the app starts automatically on boot:

### 1. Install PM2
```bash
sudo npm install -g pm2
```

### 2. Start the Application
```bash
pm2 start npm --name "meshtastic-ai" -- start
```

### 3. Save PM2 Process List
```bash
pm2 save
pm2 startup
# Follow the on-screen instructions to enable boot persistence
```

---

## Phase 4: Connecting Meshtastic Nodes

### 1. Identify the Node
Plug your Meshtastic device (e.g., T-Beam, Heltec v3) into the Dell GB10 USB port. Verify it is detected:
```bash
dmesg | grep tty
# Usually appears as /dev/ttyUSB0 or /dev/ttyACM0
```

### 2. Configure the Node (via Meshtastic CLI)
Install the Meshtastic CLI on the gateway:
```bash
pip3 install meshtastic
```

Test the connection:
```bash
meshtastic --info
```

### 3. Bridge to Raspberry Pi / Sensors
If your node is connected to a Raspberry Pi or the Dell GB10 is acting as the host:
- Ensure the **Serial Module** is enabled on the Meshtastic node.
- If using I2C sensors (BME680, etc.), ensure they are wired to the node's I2C pins or the Gateway's GPIO.

---

## Phase 5: Accessing the UI
Once deployed, the UI will be accessible at:
`http://<dell-gb10-ip-address>:3000`

### Troubleshooting Connecting to Nodes:
- **Permission Denied:** Check `ls -l /dev/ttyUSB0` to ensure the group has read/write access.
- **Port Busy:** Ensure no other software (like the Meshtastic CLI or another terminal) is using the port.
- **No Data:** Ensure the `Telemetry` and `Text Message` modules are enabled on your mesh network nodes.

---
*Document generated for Net-AI Meshtastic Assistant - v1.0*
