# Network & Device Reference

## Router

| Field | Value |
|-------|-------|
| Model | TP-Link HX510 v2.8 (Aginet ISP firmware) |
| Firmware | 0.7.0 3.0.0 v6065.0 Build 250724 |
| LAN IP | 192.168.88.1 |
| Admin URL | http://192.168.88.1 |
| Admin user | admin |
| Admin password | MUPY5qwyxXQ@9cX |
| WiFi SSID | svhome |
| WiFi password | 9663375833 |
| WiFi bands | 2.4GHz (channel 11) + 5GHz |
| WAN type | PPPoE (ACT Fibernet) |
| WAN IP | 10.246.99.6 (ISP NAT) |
| DHCP range | 192.168.88.1 – 192.168.88.254 |
| DNS | 49.205.72.130, 183.82.243.66 |

### Router notes

- **WiFi ↔ wired bridging works correctly**. The router bridges WiFi and wired clients on the same subnet. TCP, ICMP all work between interfaces.
- **AP Isolation**: Disabled on both 2.4GHz and 5GHz.
- **SPI Firewall**: Disabled (IPv4). Can be re-enabled — only affects WAN→LAN, and router is behind ISP NAT anyway.
- **Access Control**: Enabled with empty deny list (no effect).

### RPi firewall (UFW)

**UFW is active with INPUT policy DROP.** This was the cause of connectivity issues (not the router). Allowed ports:
- Port 22/tcp from 192.168.88.0/24 (SSH from LAN)
- Port 22/tcp from 100.64.0.0/10 (SSH from Tailscale)
- Port 3141/tcp from 192.168.88.0/24 (Eurisco ingest server)
- All traffic on tailscale0 interface

---

## Devices

### Raspberry Pi 5 (eurisco)

| Field | Value |
|-------|-------|
| Hostname | rpicb5 |
| Model | Raspberry Pi 5 Model B Rev 1.0 |
| OS | Debian 12 (bookworm) |
| Node.js | v22.22.0 |
| Ethernet MAC | 2C:CF:67:6E:B4:A5 |
| Ethernet IP | 192.168.88.9 (DHCP) |
| WiFi MAC | 2C:CF:67:6E:B4:A6 |
| WiFi IP | Not connected (not needed — eth0 reaches all WiFi devices) |
| Tailscale IP | 100.78.213.92 |
| SSH user | admin |
| SSH password | admin |
| SSH config alias | `rpi` (via Tailscale) or `rpi-local` (via LAN) |
| App directory | /home/admin/kit |
| Process manager | PM2 (`npx pm2 restart eurisco`) |
| Ingest server | http://0.0.0.0:3141 (sleep, temperature) |

### ESP8266 (NodeMCU Amica v1.9) — Temperature, Humidity & AC IR Control

| Field | Value |
|-------|-------|
| Board | NodeMCU Amica v1.9 (ESP8266) |
| Hostname | ESP-561DE2 (OTA: eurisco-sensor) |
| MAC | CC:50:E3:56:1D:E2 |
| WiFi IP | 192.168.88.51 (static, set in sketch) |
| OTA password | eurisco |
| Sensor | DHT11 on D6 (GPIO12). BME280 on order (I2C D1/D2). |
| IR LED | D5 (GPIO14) + BC547 + 220Ω (pending hardware) |
| HTTP endpoint | GET http://192.168.88.51/temperature |
| Response format | `{"temp": 29.5, "humidity": 47.0}` |
| Pending endpoints | POST /ac/on, POST /ac/off, GET /ac/status |
| Location | Bedroom |
| Polling | RPi polls every 30s via `startTemperaturePoller()` |
| Env var | `ESP32_TEMPERATURE_URL=http://192.168.88.51/temperature` |

### Tuya IR Blaster — Daikin AC Control

| Field | Value |
|-------|-------|
| Device name | Smart IR |
| MAC | 80:64:7C:DF:4C:7F |
| WiFi IP | 192.168.88.2 (DHCP, not reachable from RPi) |
| Tuya device ID | d7c1f0533942afc97aahbq |
| AC sub-device ID | d75259fb48d198248fhtpb |
| Local key | `4~e}F1r-vLm)r~*a` |
| Protocol | Tuya Cloud API (fallback — local protocol blocked by router) |
| Controls | Daikin AC via IR (power, temp 16-30°C, mode, fan) |

### Tuya Smart Plug — AC Power Monitor

| Field | Value |
|-------|-------|
| Device name | Acpower |
| Tuya device ID | d7cc9465ea2d8e14b3l3jx |
| Local key | `` `@}`DSvT)?2l)2IO `` |
| Protocol | Tuya Cloud API (same limitation as IR blaster) |
| Reads | cur_power (watts), switch_1 (on/off) |
| Power thresholds | >50W = compressor running, 14-16W = standby, 0W = off |

### Daikin AC Unit

| Field | Value |
|-------|-------|
| Control | Via Tuya IR blaster |
| Night schedule | `config/ac-profiles.json` |
| Default profile | Sleep Optimised: 22:00 22°C → 01:00 24°C → 04:00 OFF |
| Other profiles | summer, mild, fan_only |
| Power watchdog | Every 5 min, 22:00–05:00 |

---

## Network Map

```
Internet (ACT Fibernet PPPoE)
    │
    ▼
┌──────────────────────────────────────────────┐
│  TP-Link HX510 Router (192.168.88.1)         │
│  WiFi: svhome (2.4GHz + 5GHz)               │
│                                              │
│  Ethernet ports          WiFi clients        │
│  ┌─────────────┐    ┌──────────────────┐     │
│  │ RPi eth0    │    │ RPi wlan0        │     │
│  │ .9          │    │ .50 (static)     │     │
│  │             │    │                  │     │
│  │ (SSH,       │    │ ESP32 .51        │     │
│  │  Tailscale, │    │ IR blaster .2    │     │
│  │  internet)  │    │ Smart plug       │     │
│  │             │    │ Mac .21          │     │
│  └─────────────┘    └──────────────────┘     │
│        ╳ TCP blocked between these bridges   │
└──────────────────────────────────────────────┘

RPi .9 ◄──── polls every 30s ────► ESP32 .51
  (eth0 to WiFi — router bridges correctly)

RPi .9 ◄──── Tuya Cloud API ────► Tuya IR/Plug
  (via internet — cloud subscription required)
```

---

## SSH Access

From any machine with Tailscale:
```bash
ssh admin@100.78.213.92     # or: ssh rpi
```

~/.ssh/config entries:
```
Host rpi
    HostName 100.78.213.92
    User admin

Host rpi-local
    HostName 192.168.88.9
    User admin
```

---

## Tuya Cloud API

| Field | Value |
|-------|-------|
| Platform | https://iot.tuya.com |
| Region | India (openapi.tuyain.com) |
| Access ID | tydkv8h5qrkp7useh5kh |
| Access Secret | a38b1df894e946d1bbbb561dcee03f52 |
| Subscription | IoT Core trial (renews monthly, free) |
| Status | Active (expires ~monthly, must renew at iot.tuya.com) |

**Note**: The Tuya cloud is a temporary dependency. The IR blaster and smart plug are cloud-only devices (local protocol port 6668 is not exposed). Plan: replace with ESP32 + IR LED + `IRremoteESP8266` library for cloud-free AC control.

---

## Data Paths

| Data | Source | Destination | Path |
|------|--------|-------------|------|
| Temperature | ESP32 DHT | workspace/climate/YYYY-MM-DD.log | RPi polls ESP32 HTTP every 30s |
| AC power | Tuya smart plug | workspace/ac/YYYY-MM-DD.log | AC scheduler polls via cloud API |
| AC commands | Eurisco agent | Daikin AC | Tuya cloud → IR blaster → IR signal |
| Sleep data | iOS Shortcut | workspace/sleep/ | POST to RPi:3141/sleep |
