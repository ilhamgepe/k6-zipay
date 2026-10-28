import { check } from "k6";
import http from "k6/http";
import crypto from "k6/crypto";
import { Counter } from "k6/metrics";
import { Options } from "k6/options";
import exec from "k6/execution";
/* @ts-ignore */
import { htmlReport } from "https://cdn.jsdelivr.net/gh/benc-uk/k6-reporter@3.0.4/dist/bundle.js";
/* @ts-ignore */
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

const statusCounter = new Counter("api_status");

export const options: Options = {
  scenarios: {
    qris_100_rps: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
  thresholds: {
    // Toleransi error create QR < 1%
    http_req_failed: ["rate<0.01"],
    // 95% request diharapkan selesai di bawah 1 detik
    http_req_duration: ["p(95)<1000"],
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
  // 2 karakter salt acak (00 - ZZ, 1296 variasi) untuk mencegah tabrakan bila test dipicu di detik yang sama
  const salt = Math.floor(Math.random() * 1296)
    .toString(36)
    .toUpperCase()
    .padStart(2, "0");
  return {
    runPrefix: `${timeStr}${salt}`, // 14 karakter (contoh: 261028150427A1)
  };
}

export default function (data?: SetupData): void {
  // Format: Q-<YYMMDDHHmmss><SALT>-<ITER>
  // Panjang: 2 + 14 + 1 + 5 = 22 karakter (aman di bawah batas maksimal 25 karakter)
  // Contoh: Q-261028150427A1-00000
  // Dijamin unik antar-run (karena timestamp + salt beda setiap eksekusi)
  // dan dijamin unik antar-request di dalam run (iterationInTest strictly unique)
  const prefix = data?.runPrefix || Date.now().toString(36).slice(-8);
  const iter = String(exec.scenario.iterationInTest).padStart(5, "0");
  const externalId = `Q-${prefix}-${iter}`;
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

  statusCounter.add(1, { status: String(res.status) });

  const durationMs = Math.round(res.timings.duration);

  // 1. Log Error jika request gagal / status bukan 200
  if (res.status !== 200 || res.error) {
    const reason = res.error ? "REQUEST_ERROR" : "HTTP_ERROR";
    console.log(
      `[ERROR] reason=${reason} externalId=${externalId} status=${res.status} duration=${durationMs}ms error=${res.error} error_code=${res.error_code} body=${res.body}`,
    );
  }
  // 2. Warning jika respon lambat (> 1000ms)
  else if (durationMs > 1000) {
    console.log(
      `[WARN] SLOW_RESPONSE (>1s) externalId=${externalId} status=${res.status} duration=${durationMs}ms`,
    );
  }

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}

export function handleSummary(data: any): Record<string, string> {
  return {
    "logs/qris-100rps.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
