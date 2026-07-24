import { lookup } from "node:dns/promises";
import dgram from "node:dgram";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const DISCOVERY_TIMEOUT_MS = 1500;
const DNS_TIMEOUT_MS = 1200;
const UPSTREAM_TIMEOUT_MS = 5000;

function jsonError(message: string, status: number) {
  return Response.json({ ok: false, error: message }, { status });
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function encodeMdnsQuery(hostname: string) {
  const labels = hostname.replace(/\.$/, "").split(".");
  const encoded: number[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length === 0 || bytes.length > 63) {
      throw new Error("mDNSホスト名が不正です");
    }
    encoded.push(bytes.length, ...bytes);
  }
  encoded.push(0);

  const packet = Buffer.alloc(12 + encoded.length + 4);
  packet.writeUInt16BE(1, 4);
  Buffer.from(encoded).copy(packet, 12);
  const questionEnd = 12 + encoded.length;
  packet.writeUInt16BE(1, questionEnd);
  // QU bit: Pico should return the answer directly to this UDP source port.
  packet.writeUInt16BE(0x8001, questionEnd + 2);
  return packet;
}

function skipDnsName(packet: Buffer, start: number) {
  let offset = start;
  let iterations = 0;
  while (offset < packet.length && iterations++ < packet.length) {
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      return offset + 2 <= packet.length ? offset + 2 : -1;
    }
    if (length === 0) return offset + 1;
    if (length > 63 || offset + 1 + length > packet.length) return -1;
    offset += 1 + length;
  }
  return -1;
}

function readMdnsAddress(packet: Buffer) {
  if (packet.length < 12) return null;
  const questionCount = packet.readUInt16BE(4);
  const answerCount = packet.readUInt16BE(6);
  let offset = 12;

  for (let index = 0; index < questionCount; index += 1) {
    offset = skipDnsName(packet, offset);
    if (offset < 0 || offset + 4 > packet.length) return null;
    offset += 4;
  }

  for (let index = 0; index < answerCount; index += 1) {
    offset = skipDnsName(packet, offset);
    if (offset < 0 || offset + 10 > packet.length) return null;
    const type = packet.readUInt16BE(offset);
    const recordClass = packet.readUInt16BE(offset + 2) & 0x7fff;
    const dataLength = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + dataLength > packet.length) return null;
    if (type === 1 && recordClass === 1 && dataLength === 4) {
      return `${packet[offset]}.${packet[offset + 1]}.${packet[offset + 2]}.${packet[offset + 3]}`;
    }
    offset += dataLength;
  }
  return null;
}

async function discoverMdns(hostname: string) {
  const query = encodeMdnsQuery(hostname);
  return new Promise<string>((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    const finish = (error?: Error, address?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(address as string);
    };
    const timer = setTimeout(
      () => finish(new Error(`${hostname} がLAN内で見つかりません`)),
      DISCOVERY_TIMEOUT_MS,
    );

    socket.on("error", (error) => finish(error));
    socket.on("message", (packet) => {
      const address = readMdnsAddress(packet);
      if (address && isPrivateIpv4(address)) finish(undefined, address);
    });
    socket.bind(0, () => {
      socket.setMulticastTTL(255);
      socket.send(query, MDNS_PORT, MDNS_ADDRESS, (error) => {
        if (error) finish(error);
      });
    });
  });
}

async function resolvePrivateAddress(hostname: string) {
  if (isIP(hostname) === 4) {
    if (!isPrivateIpv4(hostname)) {
      throw new Error("接続先はLAN内のIPv4アドレスに限定されています");
    }
    return hostname;
  }

  if (hostname.toLowerCase().endsWith(".local")) {
    try {
      return await discoverMdns(hostname);
    } catch {
      // Some operating systems resolve .local through getaddrinfo.
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const dnsTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${hostname} の名前解決がタイムアウトしました`)),
      DNS_TIMEOUT_MS,
    );
  });
  let resolvedAddress: string;
  try {
    const result = await Promise.race([
      lookup(hostname, { family: 4 }),
      dnsTimeout,
    ]);
    resolvedAddress = result.address;
  } catch {
    throw new Error(
      `${hostname} がLAN内で見つかりません。Picoの電源・LANケーブル・新しいファームウェアを確認してください`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!isPrivateIpv4(resolvedAddress)) {
    throw new Error("接続先はLAN内のアドレスではありません");
  }
  return resolvedAddress;
}

function endpointAllowed(method: string, path: string) {
  if (method === "GET" && (path === "api/status" || path === "api/health")) {
    return true;
  }
  if (method === "POST" && path === "api/stop") return true;
  return (
    (method === "PUT" || method === "POST") &&
    (path === "api/motors/1" || path === "api/motors/2")
  );
}

async function proxyRequest(request: Request, context: RouteContext) {
  const { path: segments } = await context.params;
  const path = segments.join("/");
  if (!endpointAllowed(request.method, path)) {
    return jsonError("許可されていないPico APIです", 404);
  }

  const requestUrl = new URL(request.url);
  const targetValue = requestUrl.searchParams.get("target");
  if (!targetValue) return jsonError("Picoの接続先がありません", 400);

  try {
    const target = new URL(targetValue);
    if (
      target.protocol !== "http:" ||
      target.username ||
      target.password ||
      (target.port && target.port !== "80")
    ) {
      return jsonError("Picoの接続先はHTTPポート80を指定してください", 400);
    }

    const address = await resolvePrivateAddress(target.hostname);
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    const apiKey = request.headers.get("x-api-key");
    if (contentType) headers.set("Content-Type", contentType);
    if (apiKey) headers.set("X-API-Key", apiKey);
    headers.set("Host", target.hostname);

    const upstream = await fetch(`http://${address}/${path}`, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ??
          "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Picoへ接続できませんでした";
    return jsonError(`Pico接続エラー: ${message}`, 504);
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
