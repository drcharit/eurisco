/**
 * AC Control via Tuya IR Blaster
 *
 * Usage:
 *   npx tsx scripts/ac-control.ts on [temp] [fan] [mode]
 *   npx tsx scripts/ac-control.ts off
 *   npx tsx scripts/ac-control.ts status
 *   npx tsx scripts/ac-control.ts schedule-night
 *
 * Params:
 *   temp: 16-30 (default 24)
 *   fan:  0=auto, 1=low, 2=medium, 3=high (default 1)
 *   mode: 0=cool, 1=heat, 2=auto, 3=fan, 4=dehumidify (default 0)
 */

import * as crypto from 'crypto';
import * as https from 'https';

const ACCESS_ID = 'tydkv8h5qrkp7useh5kh';
const ACCESS_SECRET = 'a38b1df894e946d1bbbb561dcee03f52';
const BASE_URL = 'openapi.tuyain.com';
const IR_ID = 'd7c1f0533942afc97aahbq';
const AC_ID = 'd75259fb48d198248fhtpb';

function hmacSign(key: string, msg: string): string {
  return crypto.createHmac('sha256', key).update(msg).digest('hex').toUpperCase();
}

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function request(method: string, path: string, body?: object): Promise<unknown> {
  // Step 1: Get token
  const t1 = Date.now().toString();
  const emptyHash = sha256('');
  const tokenSignStr = ACCESS_ID + t1 + `GET\n${emptyHash}\n\n/v1.0/token?grant_type=1`;
  const sign1 = hmacSign(ACCESS_SECRET, tokenSignStr);
  const tokenData = await httpRequest('GET', '/v1.0/token?grant_type=1', undefined, {
    client_id: ACCESS_ID,
    sign: sign1,
    t: t1,
    sign_method: 'HMAC-SHA256',
  }) as { success: boolean; result?: { access_token: string }; msg?: string };
  if (!tokenData.success || !tokenData.result) {
    throw new Error(`Token failed: ${tokenData.msg}`);
  }
  const token = tokenData.result.access_token;

  // Step 2: Signed request
  const t2 = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const contentHash = sha256(bodyStr);
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const signStr = ACCESS_ID + token + t2 + stringToSign;
  const sign2 = hmacSign(ACCESS_SECRET, signStr);

  return httpRequest(method, path, body, {
    client_id: ACCESS_ID,
    access_token: token,
    sign: sign2,
    t: t2,
    sign_method: 'HMAC-SHA256',
  });
}

function httpRequest(method: string, path: string, body?: object, headers?: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: BASE_URL,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function acCommand(power: number, temp: number, mode: number, wind: number): Promise<boolean> {
  const path = `/v2.0/infrareds/${IR_ID}/air-conditioners/${AC_ID}/scenes/command`;
  const result = await request('POST', path, { power, mode, temp, wind }) as { success: boolean };
  return result.success;
}

async function acStatus(): Promise<{ power: string; temp: string; mode: string; wind: string }> {
  const path = `/v2.0/infrareds/${IR_ID}/remotes/${AC_ID}/ac/status`;
  const result = await request('GET', path) as { result: { power: string; temp: string; mode: string; wind: string } };
  return result.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MODE_NAMES = ['cool', 'heat', 'auto', 'fan', 'dehumidify'] as const;
const FAN_NAMES = ['auto', 'low', 'medium', 'high'] as const;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'on': {
      const temp = parseInt(args[0]) || 24;
      const fan = parseInt(args[1]) || 1;
      const mode = parseInt(args[2]) || 0;
      const ok = await acCommand(1, temp, mode, fan);
      console.log(ok ? `AC ON: ${temp}°C, ${MODE_NAMES[mode]}, fan ${FAN_NAMES[fan]}` : 'FAILED');
      break;
    }
    case 'off': {
      const ok = await acCommand(0, 24, 0, 0);
      console.log(ok ? 'AC OFF' : 'FAILED');
      break;
    }
    case 'status': {
      const s = await acStatus();
      console.log(`Power: ${s.power === '1' ? 'ON' : 'OFF'}`);
      console.log(`Temp:  ${s.temp}°C`);
      console.log(`Mode:  ${MODE_NAMES[parseInt(s.mode)]}`);
      console.log(`Fan:   ${FAN_NAMES[parseInt(s.wind)]}`);
      break;
    }
    case 'schedule-night': {
      // Phase 1: 22°C cool, low fan
      console.log(`[${new Date().toLocaleTimeString()}] Phase 1: AC ON 22°C, cool, fan low`);
      await acCommand(1, 22, 0, 1);

      // Phase 2: wait until 1 AM (or 3h from now in test mode)
      const now = new Date();
      const oneAm = new Date(now);
      oneAm.setHours(1, 0, 0, 0);
      if (oneAm <= now) oneAm.setDate(oneAm.getDate() + 1);
      const wait1 = oneAm.getTime() - Date.now();
      console.log(`  Waiting ${Math.round(wait1 / 60000)} min until 1:00 AM...`);
      await sleep(wait1);

      console.log(`[${new Date().toLocaleTimeString()}] Phase 2: 24°C, cool, fan low`);
      await acCommand(1, 24, 0, 1);

      // Phase 3: wait until 4 AM
      const fourAm = new Date();
      fourAm.setHours(4, 0, 0, 0);
      if (fourAm <= new Date()) fourAm.setDate(fourAm.getDate() + 1);
      const wait2 = fourAm.getTime() - Date.now();
      console.log(`  Waiting ${Math.round(wait2 / 60000)} min until 4:00 AM...`);
      await sleep(wait2);

      console.log(`[${new Date().toLocaleTimeString()}] Phase 3: AC OFF`);
      await acCommand(0, 24, 0, 0);
      console.log('Night schedule complete.');
      break;
    }
    default:
      console.log('Usage: ac-control.ts <on|off|status|schedule-night> [temp] [fan] [mode]');
      console.log('  on [temp=24] [fan=1] [mode=0]  - Turn AC on');
      console.log('  off                             - Turn AC off');
      console.log('  status                          - Get AC status');
      console.log('  schedule-night                  - Run night schedule (22°C→24°C→off)');
  }
}

main().catch(console.error);
