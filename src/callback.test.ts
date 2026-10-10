import { check, sleep } from "k6";
import http from "k6/http";
import crypto from "k6/crypto";
import { Counter } from "k6/metrics";
import { Options } from "k6/options";
import { open } from "k6/experimental/fs";
/* @ts-ignore */
import { htmlReport } from "https://cdn.jsdelivr.net/gh/benc-uk/k6-reporter@3.0.4/dist/bundle.js";
/* @ts-ignore */
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

const statusCounter = new Counter("api_status");

export const options: Options = {
  scenarios: {
    callback_load: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 150,
      stages: [
        { duration: "1m", target: 6 },
        { duration: "2m", target: 18 },
        { duration: "2m", target: 30 },
        { duration: "1m", target: 30 },
        { duration: "1m", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

const ZIPAY_URL =
  __ENV.ZIPAY_URL || "https://api.zipay.co.id/altopay/qr-payment/payment";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";
const ALTO_AKEY = __ENV.ALTO_AKEY || "";
const ALTO_VKEY = __ENV.ALTO_VKEY || "";
const ALTO_PATH = __ENV.ALTO_PATH || "/altopay/qr-payment/payment";
const INPUT_FILE = __ENV.INPUT_FILE || "../input.txt";
const DEBUG = __ENV.DEBUG === "true";
// "unique" = mutate unique fields per iteration (production-like), keeps the exact
// raw format of input.txt via string substitution only.
// "replay" = send the captured body verbatim (useful to debug the signature).
const MODE = __ENV.MODE || "unique";

// Reads input.txt once in the init context. Each line is a captured RAW body,
// used verbatim (except unescaping) so the signature stays valid.
async function loadRawBodies(path: string): Promise<string[]> {
  const file = await open(path);
  const info = await file.stat();
  const buffer = new Uint8Array(info.size);
  await file.read(buffer);
  const text = new TextDecoder("utf-8").decode(buffer);

  const bodies: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine.replace(/\r+$/, "");
    if (line.trim() === "") {
      continue;
    }

    // Mimic the Go reader: unwrap outer quotes, otherwise only unescape \" -> ".
    if (line.startsWith('"') && line.endsWith('"')) {
      try {
        line = JSON.parse(line);
      } catch (e) {
        line = line.slice(1, -1).replace(/\\"/g, '"');
      }
    } else {
      line = line.replace(/\\"/g, '"');
    }

    // Normalize non-breaking space (\u00a0) to a regular space.
    line = line.replace(/\u00a0/g, " ");

    bodies.push(line);
  }
  return bodies;
}

// @ts-expect-error top-level await is supported by the k6 runtime but not by this tsconfig
const RAW_BODIES: string[] = await loadRawBodies(INPUT_FILE);

if (!RAW_BODIES.length) {
  throw new Error(`no request body found in ${INPUT_FILE}`);
}

// Format: 2026-09-23 03:31:55.461Z (UTC, space separator, milliseconds)
function altoTimestamp(): string {
  return new Date().toISOString().replace("T", " ");
}

function randomHex(len: number): string {
  const chars = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function randomAlnum(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

// Replaces only the inner value of a string field, keeping every other byte
// (whitespace, ordering, escaping) exactly as captured in the template.
function setJsonString(body: string, field: string, value: string): string {
  const re = new RegExp('("' + field + '"\\s*:\\s*")[^"]*(")');
  return body.replace(re, "$1" + value + "$2");
}

// Makes each request unique the same way real callbacks are, without ever
// re-serializing the JSON (which is what breaks the signature).
function uniqueBody(template: string, timestamp: string): string {
  const dateCompact = timestamp.slice(0, 10).replace(/-/g, "");
  const refSuffix = randomAlnum(11);
  const customerRef = `0YIQ-${randomHex(6)}-${refSuffix}-${dateCompact}`;

  let body = template;
  body = setJsonString(body, "date_time", timestamp);
  body = setJsonString(body, "customer_reference_number", customerRef);
  body = setJsonString(body, "authorization_id", randomHex(6));
  body = setJsonString(body, "forwarding_customer_reference_number", refSuffix);
  return body;
}

// Mirrors the Go generateSignature: trims trailing whitespace/NUL/VT,
// sha256 hex of the cleaned body, joins fields, then HMAC-SHA256 hex.
function generateSignature(
  method: string,
  path: string,
  apiKey: string,
  timestamp: string,
  rawBody: string,
  validationKey: string,
): string {
  const cleanBody = rawBody.replace(/[ \t\r\n\x00\x0B]+$/, "");
  const bodyHash: string = crypto.sha256(cleanBody, "hex");

  const stringToSign = [
    method.toUpperCase(),
    path,
    apiKey,
    bodyHash,
    timestamp,
  ].join(":");

  const mac = crypto.createHMAC("sha256", validationKey);
  mac.update(stringToSign);
  const signature: string = mac.digest("hex");

  if (DEBUG) {
    console.log("=== SIGNATURE DEBUG ===");
    console.log(`method    : ${method}`);
    console.log(`path      : ${path}`);
    console.log(`apiKey    : ${apiKey}`);
    console.log(`V_KEY     : ${validationKey}`);
    console.log(`timestamp : ${timestamp}`);
    console.log(`body len  : ${cleanBody.length}`);
    console.log(`body hash : ${bodyHash}`);
    console.log(`string    : ${stringToSign}`);
    console.log(`signature : ${signature}`);
    console.log(`body      : ${rawBody}`);
  }

  return signature;
}

export default function (): void {
  const timestamp = altoTimestamp();
  const template = RAW_BODIES[__ITER % RAW_BODIES.length];
  const rawBody = MODE === "unique" ? uniqueBody(template, timestamp) : template;
  const signature = generateSignature(
    "POST",
    ALTO_PATH,
    ALTO_AKEY,
    timestamp,
    rawBody,
    ALTO_VKEY,
  );

  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "X-Alto-Timestamp": timestamp,
      "X-Alto-Key": ALTO_AKEY,
      "X-Alto-Signature": signature,
    },
  };

  const res = http.post(ZIPAY_URL, rawBody, params);

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
    "logs/callback.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
