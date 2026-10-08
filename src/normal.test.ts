import { check, sleep } from "k6";
import http from "k6/http";
import crypto from "k6/crypto";
import { Counter } from "k6/metrics";
import { Options } from "k6/options";
/* @ts-ignore */
import { htmlReport } from "https://cdn.jsdelivr.net/gh/benc-uk/k6-reporter@3.0.4/dist/bundle.js";
/* @ts-ignore */
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

const statusCounter = new Counter("api_status");

export const options: Options = {
  scenarios: {
    normal_load: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 150,
      stages: [
        { duration: "1m", target: 6 }, // Ramp-up bertahap
        { duration: "2m", target: 18 }, // Naik perlahan
        { duration: "2m", target: 30 }, // Capai puncak 30 RPS (total ramp 5 menit)
        { duration: "1m", target: 30 }, // Stay di 30 RPS
        { duration: "1m", target: 0 }, // Ramp-down
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], // Error rate < 1%
    http_req_duration: ["p(95)<500"], // 95% request harus di bawah 500ms
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

export default function (): void {
  const externalId = `QR-${Date.now()}-${__VU}-${__ITER}`;
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

  if (res.status !== 200 && Math.random() < 0.05) {
    console.log(`status=${res.status} body=${res.body}`);
  }

  check(res, {
    "status is 200": (r) => r.status === 200,
    "response time < 500ms": (r) => r.timings.duration < 500,
  });

  sleep(1);
}

export function handleSummary(data: any): Record<string, string> {
  return {
    "logs/normal.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
