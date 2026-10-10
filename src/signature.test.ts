import crypto from "k6/crypto";
import { open } from "k6/experimental/fs";

const ALTO_AKEY = __ENV.ALTO_AKEY || "";
const ALTO_VKEY = __ENV.ALTO_VKEY || "";
const ALTO_PATH = __ENV.ALTO_PATH || "/altoqris2gen/altopay/qr-payment/payment";
const INPUT_FILE = __ENV.INPUT_FILE || "../input.txt";

// Fixed by default so the output can be compared 1:1 with the Go generator.
const TIMESTAMP = __ENV.ALTO_TIMESTAMP || "2026-09-23 03:31:55.461Z";
const METHOD = "POST";

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

    if (line.startsWith('"') && line.endsWith('"')) {
      try {
        line = JSON.parse(line);
      } catch (e) {
        line = line.slice(1, -1).replace(/\\"/g, '"');
      }
    } else {
      line = line.replace(/\\"/g, '"');
    }

    line = line.replace(/\u00a0/g, " ");

    bodies.push(line);
  }
  return bodies;
}

function generateSignature(
  method: string,
  path: string,
  apiKey: string,
  timestamp: string,
  rawBody: string,
  validationKey: string,
): { bodyHash: string; signature: string } {
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

  return { bodyHash, signature };
}

// @ts-expect-error top-level await is supported by the k6 runtime but not by this tsconfig
const RAW_BODIES: string[] = await loadRawBodies(INPUT_FILE);

for (let i = 0; i < RAW_BODIES.length; i++) {
  const { bodyHash, signature } = generateSignature(
    METHOD,
    ALTO_PATH,
    ALTO_AKEY,
    TIMESTAMP,
    RAW_BODIES[i],
    ALTO_VKEY,
  );

  console.log(`=== SIGNATURE #${i} ===`);
  console.log(`method    : ${METHOD}`);
  console.log(`path      : ${ALTO_PATH}`);
  console.log(`apiKey    : ${ALTO_AKEY}`);
  console.log(`timestamp : ${TIMESTAMP}`);
  console.log(`body len  : ${RAW_BODIES[i].length}`);
  console.log(`body hash : ${bodyHash}`);
  console.log(`signature : ${signature}`);
}

export default function (): void {}
