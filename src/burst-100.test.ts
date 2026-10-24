import { check } from "k6";
import http from "k6/http";
import crypto from "k6/crypto";
import { Counter } from "k6/metrics";
import { Options } from "k6/options";
/* @ts-ignore */
import { htmlReport } from "https://cdn.jsdelivr.net/gh/benc-uk/k6-reporter@3.0.4/dist/bundle.js";
/* @ts-ignore */
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

const statusCounter = new Counter("api_status");

// 1 VU = 1 request. Semua VU start bersamaan, jadi 100 QR dibuat serentak.
const BURST_VUS = Number(__ENV.BURST_VUS || 100);

export const options: Options = {
  scenarios: {
    burst_100_qris: {
      executor: "per-vu-iterations",
      vus: BURST_VUS,
      iterations: 1, // tiap VU hanya kirim 1 request
      maxDuration: "2m",
      gracefulStop: "30s",
    },
  },
  thresholds: {
    // Fokus cuma pada error create QR, bukan latency
    http_req_failed: ["rate<0.01"], // Error rate < 1%
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
  // __VU + __ITER menjamin externalId unik walau request dikirim di milidetik yang sama
  const externalId = `BURST-${Date.now()}-${__VU}-${__ITER}`;
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

  // Hanya log request yang benar-benar gagal (bukan yang sekadar lambat)
  if (res.status !== 200 || res.error) {
    const reason = res.error ? "REQUEST_ERROR" : "HTTP_ERROR";

    console.log(
      `[ERROR] reason=${reason} externalId=${externalId} status=${
        res.status
      } duration=${Math.round(res.timings.duration)}ms error=${
        res.error
      } error_code=${res.error_code} body=${res.body}`,
    );
  }

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}

export function handleSummary(data: any): Record<string, string> {
  return {
    "logs/burst-100.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
