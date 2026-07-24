import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import dgram from "node:dgram";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const URGENT_COMMAND_PORT = 5000;
const URGENT_PACKET_HEADER_SIZE = 25;
const DISCOVERY_TIMEOUT_MS = 1500;
const DNS_TIMEOUT_MS = 1200;
const UPSTREAM_TIMEOUT_MS = 1600;
const URGENT_TIMEOUT_MS = 450;
const URGENT_PARALLEL_REQUESTS = 3;
const URGENT_RETRY_ROUNDS = 3;
const ADDRESS_CACHE_MS = 30000;
const SAME_ADDRESS_ATTEMPTS = 4;
const REFRESHED_ADDRESS_ATTEMPTS = 2;
const RETRY_DELAY_MS = 75;
const DEFAULT_PICO_HOSTNAME = "pico-motor.local";
const LINK_LOCAL_FALLBACK = "169.254.50.50";
const COMMAND_SESSION_ID = (() => {
  const value = randomBytes(2).readUInt16BE(0);
  return value === 0 ? 1 : value;
})();

type AddressCacheEntry = {
  address: string;
  expiresAt: number;
};

const addressCache = new Map<string, AddressCacheEntry>();
const addressResolution = new Map<string, Promise<string>>();

function encodeUrgentCommand(
  path: string,
  body: string | undefined,
  apiKey: string,
  commandId: string | null,
) {
  const heartbeat = path === "api/heartbeat";
  if (!heartbeat && (!commandId || !/^[1-9]\d{0,19}$/.test(commandId))) {
    throw new Error("操作命令IDが不正です");
  }
  const key = Buffer.from(apiKey, "utf8");
  if (key.length > 64) throw new Error("APIキーが長すぎます");

  let type = heartbeat ? 2 : 0;
  let motorId = 0;
  let speed = 0;
  if (path === "api/motors/sync") {
    type = 3;
    const parsed = JSON.parse(body ?? "{}") as {
      speed1?: unknown;
      speed2?: unknown;
    };
    if (
      [parsed.speed1, parsed.speed2].some(
        (value) =>
          !Number.isInteger(value) ||
          (value as number) < -20000 ||
          (value as number) > 20000,
      )
    ) {
      throw new Error("2台分の速度指定が不正です");
    }
    motorId = parsed.speed1 as number;
    speed = parsed.speed2 as number;
  }
  if (path === "api/motors/1" || path === "api/motors/2") {
    type = 1;
    motorId = path.endsWith("/1") ? 0x100 : 0x101;
    const parsed = JSON.parse(body ?? "{}") as { speed?: unknown };
    if (
      !Number.isInteger(parsed.speed) ||
      (parsed.speed as number) < -20000 ||
      (parsed.speed as number) > 20000
    ) {
      throw new Error("速度指定が不正です");
    }
    speed = parsed.speed as number;
  }

  const packet = Buffer.alloc(URGENT_PACKET_HEADER_SIZE + key.length);
  packet.write("PMOT", 0, "ascii");
  packet[4] = 1;
  packet[5] = type;
  packet.writeUInt16BE(heartbeat ? 0 : COMMAND_SESSION_ID, 6);
  packet.writeBigUInt64BE(
    heartbeat ? BigInt(0) : BigInt(commandId as string),
    8,
  );
  if (type === 3) packet.writeInt32BE(motorId, 16);
  else packet.writeUInt32BE(motorId, 16);
  packet.writeInt32BE(speed, 20);
  packet[24] = key.length;
  key.copy(packet, URGENT_PACKET_HEADER_SIZE);
  return packet;
}

function sendUrgentCommand(
  address: string,
  packet: Buffer,
) {
  return new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // A bind error can occur before the UDP socket becomes closable.
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("Pico即時命令がタイムアウトしました")),
      URGENT_TIMEOUT_MS,
    );
    socket.once("error", finish);
    socket.bind(0, localAddressFor(address), () => {
      let remaining = URGENT_PARALLEL_REQUESTS;
      for (let copy = 0; copy < URGENT_PARALLEL_REQUESTS; copy += 1) {
        socket.send(packet, URGENT_COMMAND_PORT, address, (error) => {
          if (error) {
            finish(error);
            return;
          }
          remaining -= 1;
          if (remaining === 0) finish();
        });
      }
    });
  });
}

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

function ipv4Number(address: string) {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function localAddressFor(remoteAddress: string) {
  const remote = ipv4Number(remoteAddress);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (
        address.internal ||
        address.family !== "IPv4" ||
        !isPrivateIpv4(address.address)
      ) {
        continue;
      }
      const mask = ipv4Number(address.netmask);
      if ((remote & mask) === (ipv4Number(address.address) & mask)) {
        return address.address;
      }
    }
  }
  return undefined;
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
  const interfaceAddresses = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (
        !address.internal &&
        address.family === "IPv4" &&
        isPrivateIpv4(address.address)
      ) {
        interfaceAddresses.add(address.address);
      }
    }
  }
  // Let the OS select an interface only when no usable IPv4 interface was
  // reported. Normally one socket is opened for every Wi-Fi/Ethernet adapter.
  const outgoingInterfaces =
    interfaceAddresses.size > 0 ? [...interfaceAddresses] : [undefined];

  return new Promise<string>((resolve, reject) => {
    const sockets: dgram.Socket[] = [];
    const failedSockets = new Set<dgram.Socket>();
    let settled = false;
    let lastError = new Error(`${hostname} がLAN内で見つかりません`);
    const finish = (error?: Error, address?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // A socket can fail before bind() completes.
        }
      }
      if (error) reject(error);
      else resolve(address as string);
    };
    const failSocket = (socket: dgram.Socket, error: Error) => {
      if (settled || failedSockets.has(socket)) return;
      failedSockets.add(socket);
      lastError = error;
      try {
        socket.close();
      } catch {
        // The aggregate timeout or another interface can still succeed.
      }
      if (failedSockets.size === sockets.length) finish(lastError);
    };
    const timer = setTimeout(
      () => finish(new Error(`${hostname} がLAN内で見つかりません`)),
      DISCOVERY_TIMEOUT_MS,
    );

    for (const interfaceAddress of outgoingInterfaces) {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sockets.push(socket);
      socket.on("error", (error) => failSocket(socket, error));
      socket.on("message", (packet) => {
        const address = readMdnsAddress(packet);
        if (address && isPrivateIpv4(address)) finish(undefined, address);
      });
      socket.bind(0, () => {
        try {
          socket.setMulticastTTL(255);
          if (interfaceAddress) {
            socket.setMulticastInterface(interfaceAddress);
          }
          socket.send(query, MDNS_PORT, MDNS_ADDRESS, (error) => {
            if (error) failSocket(socket, error);
          });
        } catch (error) {
          failSocket(
            socket,
            error instanceof Error ? error : new Error("mDNS送信に失敗しました"),
          );
        }
      });
    }
  });
}

async function resolvePrivateAddressUncached(hostname: string) {
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
    if (hostname.toLowerCase() === DEFAULT_PICO_HOSTNAME) {
      // Direct PC-to-Pico connections always use this deterministic address.
      // This also works on systems where .local lookup is unavailable.
      return LINK_LOCAL_FALLBACK;
    }
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

async function resolvePrivateAddress(hostname: string, forceRefresh = false) {
  const key = hostname.toLowerCase();
  if (isIP(hostname) === 4) {
    return resolvePrivateAddressUncached(hostname);
  }

  if (forceRefresh) {
    // Keep the last known address available to safety and motor UDP packets
    // while the slower mDNS/DNS refresh runs in parallel.
  } else {
    const cached = addressCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.address;
    }
  }
  const pending = addressResolution.get(key);
  if (pending) return pending;

  const resolution = resolvePrivateAddressUncached(hostname)
    .then((address) => {
      addressCache.set(key, {
        address,
        expiresAt: Date.now() + ADDRESS_CACHE_MS,
      });
      return address;
    })
    .finally(() => {
      addressResolution.delete(key);
    });
  addressResolution.set(key, resolution);
  return resolution;
}

function endpointAllowed(method: string, path: string) {
  if (method === "GET" && (path === "api/status" || path === "api/health")) {
    return true;
  }
  if (
    method === "POST" &&
    (path === "api/stop" || path === "api/heartbeat")
  ) {
    return true;
  }
  return (
    (method === "PUT" || method === "POST") &&
    (path === "api/motors/1" ||
      path === "api/motors/2" ||
      path === "api/motors/sync")
  );
}

function requestPico(
  address: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
) {
  return new Promise<{
    status: number;
    contentType: string | undefined;
    text: string;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: address,
        port: 80,
        path: `/${path}`,
        method,
        headers,
        localAddress: localAddressFor(address),
        family: 4,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65536) {
            request.destroy(new Error("Picoの応答が大きすぎます"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 502,
            contentType: response.headers["content-type"],
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("PicoのHTTP応答がタイムアウトしました"));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function requestPicoUrgent(
  address: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
) {
  let lastError: unknown;
  for (let round = 0; round < URGENT_RETRY_ROUNDS; round += 1) {
    try {
      // W5500 has four HTTP listener sockets. Sending the same idempotent
      // command to three of them avoids waiting for a socket that is still
      // completing an older TCP close. X-Command-Id makes late copies stale.
      return await Promise.any(
        Array.from({ length: URGENT_PARALLEL_REQUESTS }, () =>
          requestPico(
            address,
            path,
            method,
            headers,
            body,
            URGENT_TIMEOUT_MS,
          ),
        ),
      );
    } catch (error) {
      lastError = error;
      if (round + 1 < URGENT_RETRY_ROUNDS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Picoへ緊急命令を送信できませんでした");
}

async function requestPicoWithRetries(
  address: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  attempts: number,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestPico(address, path, method, headers, body);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Picoへ接続できませんでした");
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

    const headers: Record<string, string> = {
      Host: target.hostname,
      Connection: "close",
    };
    const contentType = request.headers.get("content-type");
    const apiKey = request.headers.get("x-api-key");
    const commandId = request.headers.get("x-command-id");
    if (contentType) headers["Content-Type"] = contentType;
    if (apiKey) headers["X-API-Key"] = apiKey;
    if (commandId) headers["X-Command-Id"] = commandId;

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.text();
    const urgent =
      path === "api/stop" ||
      path === "api/motors/1" ||
      path === "api/motors/2" ||
      path === "api/motors/sync";
    const heartbeat = path === "api/heartbeat";
    const fetchUpstream = async (address: string) =>
      urgent
        ? requestPicoUrgent(
            address,
            path,
            request.method,
            headers,
            body,
          )
        : requestPicoWithRetries(
            address,
            path,
            request.method,
            headers,
            body,
            SAME_ADDRESS_ATTEMPTS,
          );

    // A safety heartbeat must never pause for mDNS. The normal connection or
    // status request has already cached the resolved address; keep using that
    // address until a status/reconnect request discovers a replacement.
    const cachedAddress = addressCache.get(target.hostname.toLowerCase());
    let address =
      (heartbeat || urgent) && cachedAddress
        ? cachedAddress.address
        : await resolvePrivateAddress(target.hostname);
    if (heartbeat) {
      const packet = encodeUrgentCommand(
        path,
        undefined,
        apiKey ?? "",
        null,
      );
      await sendUrgentCommand(address, packet);
      return Response.json(
        { ok: true, transport: "udp" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (urgent && commandId) {
      const packet = encodeUrgentCommand(
        path,
        body,
        apiKey ?? "",
        commandId,
      );
      // Motor commands complete on the low-latency UDP path. A separate status
      // poll confirms the resulting state without delaying the next operation.
      await sendUrgentCommand(address, packet);
      return Response.json(
        { ok: true, transport: "udp" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    let upstream;
    try {
      upstream = await fetchUpstream(address);
    } catch {
      // The Pico may have rebooted or received a new DHCP address. Discard both
      // the address cache after retrying the known LAN path, then resolve again.
      address = await resolvePrivateAddress(target.hostname, true);
      upstream = urgent
        ? await requestPicoUrgent(
            address,
            path,
            request.method,
            headers,
            body,
          )
        : await requestPicoWithRetries(
            address,
            path,
            request.method,
            headers,
            body,
            REFRESHED_ADDRESS_ATTEMPTS,
          );
    }
    return new Response(upstream.text, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.contentType ?? "application/json; charset=utf-8",
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
