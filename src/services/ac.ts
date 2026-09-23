/**
 * Tuya AC control + smart plug power monitoring.
 *
 * Two transports, tried in order:
 *   1. Local LAN protocol (TCP port 6668, AES-128-ECB) — no cloud, no subscription
 *   2. Cloud API fallback (HTTPS to openapi.tuyain.com) — used only if local fails
 *
 * Once local works, remove the cloud credentials from .env and the fallback is dead code.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import * as https from "node:https";

export interface ACCredentials {
  // Local protocol (preferred)
  irBlasterIp: string;
  irBlasterKey: string;       // 16-char local key
  // Cloud fallback (until local is working)
  cloudAccessId: string;
  cloudAccessSecret: string;
  // Shared
  irBlasterDeviceId: string;  // gateway / IR device ID
  acSubDeviceId: string;      // virtual AC device
  plugIp: string;
  plugKey: string;
  plugDeviceId: string;
}

export interface ACState {
  power: boolean;
  temp: number;
  mode: number;
  wind: number;
}

const MODE_NAMES = ["cool", "heat", "auto", "fan", "dehumidify"] as const;
const FAN_NAMES = ["auto", "low", "medium", "high"] as const;

// ══════════════════════════════════════════════════════════════════════════════
// TRANSPORT 1: Local LAN protocol (Tuya v3.3)
// ══════════════════════════════════════════════════════════════════════════════

const PORT = 6668;
const PREFIX = 0x000055AA;
const SUFFIX = 0x0000AA55;
const CMD_CONTROL = 7;
const CMD_DP_QUERY = 10;
const CONNECT_TIMEOUT = 5_000;

let seqNo = 1;

function aesEncrypt(data: string, key: string): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
}

function aesDecrypt(data: Buffer, key: string): string {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildFrame(command: number, payload: Buffer): Buffer {
  const seq = seqNo++;
  const len = payload.length + 8;
  const buf = Buffer.alloc(16 + payload.length + 8);
  buf.writeUInt32BE(PREFIX, 0);
  buf.writeUInt32BE(seq, 4);
  buf.writeUInt32BE(command, 8);
  buf.writeUInt32BE(len, 12);
  payload.copy(buf, 16);
  buf.writeUInt32BE(crc32(buf.subarray(0, 16 + payload.length)), 16 + payload.length);
  buf.writeUInt32BE(SUFFIX, 16 + payload.length + 4);
  return buf;
}

function parseResponse(data: Buffer, key: string): Record<string, unknown> {
  const prefixIdx = data.indexOf(Buffer.from([0x00, 0x00, 0x55, 0xAA]));
  if (prefixIdx === -1) throw new Error("No frame prefix found");

  const frameLen = data.readUInt32BE(prefixIdx + 12);
  let payloadBuf = data.subarray(prefixIdx + 16, prefixIdx + 16 + frameLen - 8);

  const retCode = payloadBuf.readUInt32BE(0);
  if (retCode === 0 && payloadBuf.length > 4) payloadBuf = payloadBuf.subarray(4);
  if (payloadBuf.length === 0) return {};
  if (payloadBuf.length >= 15 && payloadBuf.subarray(0, 3).toString() === "3.3") {
    payloadBuf = payloadBuf.subarray(15);
  }

  try {
    return JSON.parse(aesDecrypt(payloadBuf, key)) as Record<string, unknown>;
  } catch {
    try { return JSON.parse(payloadBuf.toString("utf8")) as Record<string, unknown>; }
    catch { return {}; }
  }
}

function localSend(
  ip: string, key: string, command: number,
  dps: Record<string, unknown>, gwId: string, devId: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify({ gwId, devId, uid: "", t: Math.floor(Date.now() / 1000), dps });
    let payload: Buffer;
    if (command === CMD_CONTROL) {
      const header = Buffer.alloc(15);
      header.write("3.3");
      payload = Buffer.concat([header, aesEncrypt(json, key)]);
    } else {
      payload = aesEncrypt(json, key);
    }

    const frame = buildFrame(command, payload);
    const chunks: Buffer[] = [];
    const sock = net.createConnection({ host: ip, port: PORT });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Timeout ${ip}:${PORT}`)); }, CONNECT_TIMEOUT);

    sock.on("connect", () => sock.write(frame));
    sock.on("data", (chunk) => {
      chunks.push(chunk);
      const full = Buffer.concat(chunks);
      if (full.length >= 24 && full.readUInt32BE(full.length - 4) === SUFFIX) {
        clearTimeout(timer);
        sock.destroy();
        try { resolve(parseResponse(full, key)); } catch (e) { reject(e); }
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    sock.on("timeout", () => { sock.destroy(); clearTimeout(timer); reject(new Error(`Socket timeout ${ip}`)); });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TRANSPORT 2: Cloud API fallback
// ══════════════════════════════════════════════════════════════════════════════

const CLOUD_HOST = "openapi.tuyain.com";

function hmac(key: string, msg: string): string {
  return crypto.createHmac("sha256", key).update(msg).digest("hex").toUpperCase();
}

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function httpReq(method: string, path: string, headers: Record<string, string>, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: CLOUD_HOST, path, method,
      headers: { "Content-Type": "application/json", ...headers,
        ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
      },
    }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function cloudGetToken(creds: ACCredentials): Promise<string> {
  const t = Date.now().toString();
  const path = "/v1.0/token?grant_type=1";
  const sign = hmac(creds.cloudAccessSecret, creds.cloudAccessId + t + `GET\n${sha256("")}\n\n${path}`);
  const raw = await httpReq("GET", path, {
    client_id: creds.cloudAccessId, sign, t, sign_method: "HMAC-SHA256",
  });
  const data = JSON.parse(raw) as { success: boolean; result?: { access_token: string }; msg?: string };
  if (!data.success) throw new Error(`Cloud token: ${data.msg}`);
  return data.result!.access_token;
}

async function cloudRequest(creds: ACCredentials, method: string, path: string, body?: object): Promise<unknown> {
  const token = await cloudGetToken(creds);
  const t = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const sign = hmac(creds.cloudAccessSecret,
    creds.cloudAccessId + token + t + `${method}\n${sha256(bodyStr)}\n\n${path}`);
  const raw = await httpReq(method, path, {
    client_id: creds.cloudAccessId, access_token: token,
    sign, t, sign_method: "HMAC-SHA256",
  }, bodyStr || undefined);
  return JSON.parse(raw);
}

// ══════════════════════════════════════════════════════════════════════════════
// Exported functions — try local, fall back to cloud
// ══════════════════════════════════════════════════════════════════════════════

function hasLocal(creds: ACCredentials): boolean {
  return !!(creds.irBlasterIp && creds.irBlasterKey);
}

function hasCloud(creds: ACCredentials): boolean {
  return !!(creds.cloudAccessId && creds.cloudAccessSecret);
}

export async function acOn(creds: ACCredentials, temp = 24, mode = 0, wind = 1): Promise<string> {
  // Try local
  if (hasLocal(creds)) {
    try {
      const dps = { "101": true, "102": String(mode), "103": temp, "104": String(wind) };
      await localSend(creds.irBlasterIp, creds.irBlasterKey, CMD_CONTROL, dps,
        creds.irBlasterDeviceId, creds.acSubDeviceId);
      return `AC ON: ${temp}°C, ${MODE_NAMES[mode]}, fan ${FAN_NAMES[wind]} (local)`;
    } catch (e) {
      console.log(`[ac] Local acOn failed: ${(e as Error).message}`);
    }
  }

  // Fall back to cloud
  if (hasCloud(creds)) {
    const path = `/v2.0/infrareds/${creds.irBlasterDeviceId}/air-conditioners/${creds.acSubDeviceId}/scenes/command`;
    const r = await cloudRequest(creds, "POST", path, { power: 1, mode, temp, wind }) as { success: boolean };
    if (!r.success) return "Failed to turn AC on (cloud)";
    return `AC ON: ${temp}°C, ${MODE_NAMES[mode]}, fan ${FAN_NAMES[wind]} (cloud)`;
  }

  return "AC ON failed: no local or cloud transport available";
}

export async function acOff(creds: ACCredentials): Promise<string> {
  if (hasLocal(creds)) {
    try {
      await localSend(creds.irBlasterIp, creds.irBlasterKey, CMD_CONTROL, { "101": false },
        creds.irBlasterDeviceId, creds.acSubDeviceId);
      return "AC OFF (local)";
    } catch (e) {
      console.log(`[ac] Local acOff failed: ${(e as Error).message}`);
    }
  }

  if (hasCloud(creds)) {
    const path = `/v2.0/infrareds/${creds.irBlasterDeviceId}/air-conditioners/${creds.acSubDeviceId}/scenes/command`;
    const r = await cloudRequest(creds, "POST", path, { power: 0, mode: 0, temp: 24, wind: 0 }) as { success: boolean };
    if (!r.success) return "Failed to turn AC off (cloud)";
    return "AC OFF (cloud)";
  }

  return "AC OFF failed: no transport available";
}

export async function acStatus(creds: ACCredentials): Promise<string> {
  let statusStr = "";

  if (hasLocal(creds)) {
    try {
      const r = await localSend(creds.irBlasterIp, creds.irBlasterKey, CMD_DP_QUERY, {},
        creds.irBlasterDeviceId, creds.acSubDeviceId);
      const dps = (r.dps ?? {}) as Record<string, unknown>;
      const m = Number(dps["102"] ?? 0);
      const t = Number(dps["103"] ?? 24);
      const f = Number(dps["104"] ?? 1);
      statusStr = `Temp: ${t}°C\nMode: ${MODE_NAMES[m] ?? "unknown"}\nFan: ${FAN_NAMES[f] ?? "unknown"} (local)`;
    } catch (e) {
      console.log(`[ac] Local status failed: ${(e as Error).message}`);
    }
  }

  if (!statusStr && hasCloud(creds)) {
    try {
      const path = `/v2.0/infrareds/${creds.irBlasterDeviceId}/remotes/${creds.acSubDeviceId}/ac/status`;
      const r = await cloudRequest(creds, "GET", path) as { success: boolean; result: ACState };
      if (r.success) {
        const s = r.result;
        statusStr = `Temp: ${s.temp}°C\nMode: ${MODE_NAMES[Number(s.mode)] ?? "unknown"}\nFan: ${FAN_NAMES[Number(s.wind)] ?? "unknown"} (cloud)`;
      }
    } catch (e) {
      console.log(`[ac] Cloud status failed: ${(e as Error).message}`);
    }
  }

  const watts = await acPowerDraw(creds);
  const actuallyOn = watts > 50;
  const powerLine = watts >= 0
    ? `Power: ${actuallyOn ? "ON" : "OFF"} (${watts.toFixed(0)}W)`
    : "Power: unknown (plug unreachable)";

  return `${powerLine}\n${statusStr || "IR status: unavailable"}`;
}

export async function acPowerDraw(creds: ACCredentials): Promise<number> {
  // Try local
  if (creds.plugIp && creds.plugKey) {
    try {
      const r = await localSend(creds.plugIp, creds.plugKey, CMD_DP_QUERY, {},
        creds.plugDeviceId, creds.plugDeviceId);
      const dps = (r.dps ?? {}) as Record<string, number>;
      const raw = dps["19"];
      if (raw !== undefined) return raw / 10;
    } catch (e) {
      console.log(`[ac] Local plug read failed: ${(e as Error).message}`);
    }
  }

  // Fall back to cloud
  if (creds.plugDeviceId && hasCloud(creds)) {
    try {
      const path = `/v1.0/iot-03/devices/${creds.plugDeviceId}/status`;
      const r = await cloudRequest(creds, "GET", path) as {
        success: boolean;
        result: Array<{ code: string; value: number }>;
      };
      if (r.success) {
        const cur = r.result.find((i) => i.code === "cur_power");
        if (cur) return cur.value / 10;
      }
    } catch (e) {
      console.log(`[ac] Cloud plug read failed: ${(e as Error).message}`);
    }
  }

  return -1;
}

export async function acIsRunning(creds: ACCredentials): Promise<boolean> {
  return (await acPowerDraw(creds)) > 50;
}

export async function acPlugCycle(creds: ACCredentials, offMs = 5000): Promise<string> {
  // Try local
  if (creds.plugIp && creds.plugKey) {
    try {
      await localSend(creds.plugIp, creds.plugKey, CMD_CONTROL, { "1": false },
        creds.plugDeviceId, creds.plugDeviceId);
      await new Promise((r) => setTimeout(r, offMs));
      await localSend(creds.plugIp, creds.plugKey, CMD_CONTROL, { "1": true },
        creds.plugDeviceId, creds.plugDeviceId);
      return "Plug power cycled (local)";
    } catch (e) {
      console.log(`[ac] Local plug cycle failed: ${(e as Error).message}`);
    }
  }

  // Fall back to cloud
  if (creds.plugDeviceId && hasCloud(creds)) {
    const path = `/v1.0/iot-03/devices/${creds.plugDeviceId}/commands`;
    await cloudRequest(creds, "POST", path, { commands: [{ code: "switch_1", value: false }] });
    await new Promise((r) => setTimeout(r, offMs));
    await cloudRequest(creds, "POST", path, { commands: [{ code: "switch_1", value: true }] });
    return "Plug power cycled (cloud)";
  }

  return "Plug cycle failed: no transport available";
}
