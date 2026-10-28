import { check } from "k6";
import http from "k6/http";
import crypto from "k6/crypto";
import { Counter } from "k6/metrics";
import { Options, Scenario } from "k6/options";
import exec from "k6/execution";
/* @ts-ignore */
import { htmlReport } from "https://cdn.jsdelivr.net/gh/benc-uk/k6-reporter@3.0.4/dist/bundle.js";
/* @ts-ignore */
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

const statusCounter = new Counter("api_status");

/**
 * CARA MENJALANKAN TEST:
 *
 * 1. Jalankan semua skenario berurutan (Total 25 menit: Baseline -> Normal -> High -> Stress -> Max):
 *    $ npm run test:qris
 *
 * 2. Jalankan target spesifik saja (5 menit):
 *    $ TARGET=baseline npm run test:qris          # 50 RPS
 *    $ TARGET=normal_load npm run test:qris       # 100 RPS
 *    $ TARGET=high_load npm run test:qris         # 250 RPS
 *    $ TARGET=stress_test npm run test:qris       # 500 RPS
 *    $ TARGET=maximum_capacity npm run test:qris  # 1.000 RPS
 *
 * 3. Quick test / ubah durasi tiap stage (misal 30 detik atau 1 menit per stage):
 *    $ DURATION=30s npm run test:qris
 *    $ TARGET=baseline DURATION=1m npm run test:qris
 */

// Konfigurasi target scenario yang diminta:
// 1. Baseline: 50 RPS, 5 menit
// 2. Normal Load: 100 RPS, 5 menit
// 3. High Load: 250 RPS, 5 menit
// 4. Stress Test: 500 RPS, 5 menit
// 5. Maximum Capacity: 1.000 RPS, 5 menit

// Helper untuk parse durasi (default 5m = 300s)
function parseDurationToSeconds(durationStr: string): number {
  if (durationStr.endsWith("m")) {
    return parseInt(durationStr, 10) * 60;
  }
  if (durationStr.endsWith("s")) {
    return parseInt(durationStr, 10);
  }
  if (durationStr.endsWith("h")) {
    return parseInt(durationStr, 10) * 3600;
  }
  return parseInt(durationStr, 10) || 300;
}

const STAGE_DURATION = __ENV.DURATION || "5m";
const durationSec = parseDurationToSeconds(STAGE_DURATION);

// Definisi target scenario
interface ScenarioDef {
  code: string;
  name: string;
  rate: number;
  preAllocatedVUs: number;
  maxVUs: number;
  order: number;
}

const TARGET_SCENARIOS: Record<string, ScenarioDef> = {
  baseline: {
    code: "B",
    name: "baseline",
    rate: 50,
    preAllocatedVUs: 50,
    maxVUs: 200,
    order: 0,
  },
  normal_load: {
    code: "N",
    name: "normal_load",
    rate: 100,
    preAllocatedVUs: 100,
    maxVUs: 400,
    order: 1,
  },
  high_load: {
    code: "H",
    name: "high_load",
    rate: 250,
    preAllocatedVUs: 200,
    maxVUs: 800,
    order: 2,
  },
  stress_test: {
    code: "S",
    name: "stress_test",
    rate: 500,
    preAllocatedVUs: 350,
    maxVUs: 1500,
    order: 3,
  },
  maximum_capacity: {
    code: "M",
    name: "maximum_capacity",
    rate: 1000,
    preAllocatedVUs: 500,
    maxVUs: 3000,
    order: 4,
  },
};

// Dukungan untuk memilih target tertentu melalui environment variable:
// e.g. TARGET=baseline / SCENARIO=normal_load (jika ingin menjalankan salah satu target saja tanpa menunggu 25 menit)
const SELECTED_TARGET = (__ENV.TARGET || __ENV.SCENARIO || "").toLowerCase();

function buildScenarios(): Record<string, Scenario> {
  const result: Record<string, Scenario> = {};

  if (SELECTED_TARGET && TARGET_SCENARIOS[SELECTED_TARGET]) {
    const s = TARGET_SCENARIOS[SELECTED_TARGET];
    result[s.name] = {
      executor: "constant-arrival-rate",
      rate: s.rate,
      timeUnit: "1s",
      duration: STAGE_DURATION,
      startTime: "0s",
      preAllocatedVUs: s.preAllocatedVUs,
      maxVUs: s.maxVUs,
    };
    return result;
  }

  // Default: Jalankan berurutan (Baseline -> Normal Load -> High Load -> Stress Test -> Maximum Capacity)
  Object.keys(TARGET_SCENARIOS).forEach((key) => {
    const s = TARGET_SCENARIOS[key];
    const startTimeSec = s.order * durationSec;
    result[s.name] = {
      executor: "constant-arrival-rate",
      rate: s.rate,
      timeUnit: "1s",
      duration: STAGE_DURATION,
      startTime: `${startTimeSec}s`,
      preAllocatedVUs: s.preAllocatedVUs,
      maxVUs: s.maxVUs,
    };
  });

  return result;
}

export const options: Options = {
  scenarios: buildScenarios(),
  thresholds: {
    // Global threshold
    http_req_failed: ["rate<0.05"], // Error global < 5%
    http_req_duration: ["p(95)<1500"], // 95% response time global < 1.5 detik

    // Thresholds per scenario
    "http_req_duration{scenario:baseline}": ["p(95)<1000"],
    "http_req_failed{scenario:baseline}": ["rate<0.01"],

    "http_req_duration{scenario:normal_load}": ["p(95)<1000"],
    "http_req_failed{scenario:normal_load}": ["rate<0.01"],

    "http_req_duration{scenario:high_load}": ["p(95)<1200"],
    "http_req_failed{scenario:high_load}": ["rate<0.02"],

    "http_req_duration{scenario:stress_test}": ["p(95)<2000"],
    "http_req_failed{scenario:stress_test}": ["rate<0.05"],

    "http_req_duration{scenario:maximum_capacity}": ["p(95)<3000"],
    "http_req_failed{scenario:maximum_capacity}": ["rate<0.10"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://api.zipay.co.id";
const MERCHANT_ID = __ENV.MERCHANT_ID || "9";
const MERCHANT_KEY =
  __ENV.MERCHANT_KEY || "2de7546d-529f-4348-a8cc-92d3d0736b09";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";
const AMOUNT = Number(__ENV.AMOUNT || 1000);

function oneHourFromNow(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number): string => (n < 10 ? "0" + n : "" + n);
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}

function generateSignature(merchantId: string, externalId: string): string {
  const payload = `${merchantId}${externalId}`;
  const hasher = crypto.createHMAC("sha256", MERCHANT_KEY);
  hasher.update(payload);
  return hasher.digest("hex");
}

interface SetupData {
  runPrefix: string;
}

export function setup(): SetupData {
  const now = new Date();
  const pad = (n: number): string => (n < 10 ? "0" + n : "" + n);
  const timeStr = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 2 karakter salt acak (00 - ZZ, 1296 kombinasi) untuk mencegah tabrakan bila dipicu di detik yang sama
  const salt = Math.floor(Math.random() * 1296)
    .toString(36)
    .toUpperCase()
    .padStart(2, "0");

  return {
    runPrefix: `${timeStr}${salt}`, // 14 karakter (contoh: 261028150427A1)
  };
}

const SCENARIO_CODES: Record<string, string> = {
  baseline: "B",
  normal_load: "N",
  high_load: "H",
  stress_test: "S",
  maximum_capacity: "M",
};

export default function (data?: SetupData): void {
  const scenarioName = exec.scenario.name || "default";
  const scenarioCode = SCENARIO_CODES[scenarioName] || "X";
  const prefix = data?.runPrefix || Date.now().toString(36).slice(-8);

  // Pad iteration 6 digit (000000 - 999999)
  // Format: Q<CODE>-<YYMMDDHHmmss><SALT>-<ITER>
  // Panjang: 2 + 1 + 14 + 1 + 6 = 24 karakter (aman di bawah batas maksimal 25 karakter Zipay)
  // Contoh: QB-261028183015A1-000001
  const iter = String(exec.scenario.iterationInTest).padStart(6, "0");
  const externalId = `Q${scenarioCode}-${prefix}-${iter}`;
  const signature = generateSignature(MERCHANT_ID, externalId);

  const payload = JSON.stringify({
    amount: AMOUNT,
    externalId,
    merchantId: MERCHANT_ID,
    signature,
    expiredAt: oneHourFromNow(),
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  };

  const res = http.post(`${BASE_URL}/payment/qr/create`, payload, params);

  statusCounter.add(1, {
    status: String(res.status),
    scenario: scenarioName,
  });

  const durationMs = Math.round(res.timings.duration);

  // 1. Log Error jika request gagal / status bukan 200
  if (res.status !== 200 || res.error) {
    const reason = res.error ? "REQUEST_ERROR" : "HTTP_ERROR";
    console.log(
      `[ERROR] scenario=${scenarioName} reason=${reason} externalId=${externalId} status=${res.status} duration=${durationMs}ms error=${res.error} error_code=${res.error_code} body=${res.body}`,
    );
  }
  // 2. Warning jika respons lambat (> 1000ms), disampling 10% di load tinggi agar stdout tidak bottleneck
  else if (durationMs > 1000) {
    if (Math.random() < 0.1) {
      console.log(
        `[WARN] SLOW_RESPONSE (>1s) scenario=${scenarioName} externalId=${externalId} status=${res.status} duration=${durationMs}ms`,
      );
    }
  }

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}

export function handleSummary(data: any): Record<string, string> {
  return {
    "logs/qris.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
