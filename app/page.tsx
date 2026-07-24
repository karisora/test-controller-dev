"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type LogItem = {
  id: number;
  time: string;
  kind: "tx" | "rx" | "info" | "error";
  message: string;
};

type MotorState = {
  id: string;
  speed: number;
  direction: 1 | -1;
  running: boolean;
};

type ApiMotor = {
  id: string;
  speed: number;
  running: boolean;
};

type ApiStatus = {
  ok: boolean;
  ip: string;
  hostname?: string;
  firmwareVersion?: string;
  networkMode?: "dhcp" | "link-local";
  motors: ApiMotor[];
  maxSpeed: number;
  watchdogMs: number;
  apiKeyRequired: boolean;
  udpDiagnosticAck?: boolean;
  udpControlProtocol?: number;
  urgentCommands?: number;
  safetyKeepalives?: number;
  udpCommandSession?: number;
  socketCommandTimeouts?: number;
  error?: string;
};

const MAX_SPEED = 20000;
const DEFAULT_DEVICE = "pico-motor.local";
const HEARTBEAT_TICK_MS = 250;
const UDP_HEARTBEAT_MS = 250;
const HTTP_HEARTBEAT_MS = 750;
const API_TIMEOUT_MS = 12000;
const RECONNECT_DELAY_MS = 2000;
const STATUS_FAILURE_LIMIT = 3;
const STATUS_RECONCILE_DELAY_MS = 500;
const REQUIRED_FIRMWARE_VERSION = "2026.07.25.21";

function nowLabel() {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Picoのホスト名またはIPアドレスを入力してください");
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HTTPまたはHTTPSのアドレスを入力してください");
  }
  return parsed.origin;
}

export default function Home() {
  const [deviceAddress, setDeviceAddress] = useState(DEFAULT_DEVICE);
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnectEnabled, setReconnectEnabled] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<ApiStatus | null>(null);
  const [motors, setMotors] = useState<MotorState[]>([
    { id: "0x100", speed: 500, direction: 1, running: false },
    { id: "0x101", speed: 500, direction: 1, running: false },
  ]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [rawCommand, setRawCommand] = useState("");

  const logIdRef = useRef(0);
  const motorsRef = useRef(motors);
  const connectedRef = useRef(connected);
  const activeBaseUrlRef = useRef("");
  const apiKeyRef = useRef(apiKey);
  const commandGenerationRef = useRef(0);
  const commandIdRef = useRef(0);
  const syncRunTokenRef = useRef(0);
  const connectingRef = useRef(false);
  const statusPollInFlightRef = useRef(false);
  const heartbeatInFlightRef = useRef(false);
  const commandInFlightRef = useRef(0);
  const lastCommandAtRef = useRef(0);
  const lastHeartbeatSentAtRef = useRef(0);
  const udpRealtimeAvailableRef = useRef(false);
  const statusFailureCountRef = useRef(0);
  const heartbeatFailureCountRef = useRef(0);

  useEffect(() => {
    motorsRef.current = motors;
  }, [motors]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    apiKeyRef.current = apiKey;
  }, [apiKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedAddress = window.localStorage.getItem("pico-device-address");
      const savedApiKey = window.localStorage.getItem("pico-api-key");
      if (savedAddress && savedAddress !== "192.168.1.50") {
        setDeviceAddress(savedAddress);
      }
      if (savedApiKey) setApiKey(savedApiKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const addLog = useCallback((kind: LogItem["kind"], message: string) => {
    setLogs((current) => [
      ...current.slice(-99),
      { id: ++logIdRef.current, time: nowLabel(), kind, message },
    ]);
  }, []);

  const applyStatus = useCallback((status: ApiStatus) => {
    setDeviceInfo(status);
    setMotors((current) =>
      current.map((motor, index) => {
        const remote = status.motors[index];
        if (!remote) return motor;
        return {
          ...motor,
          id: remote.id,
          running: remote.running,
          direction:
            remote.running && !motor.running
              ? remote.speed < 0 ? -1 : 1
              : motor.direction,
          speed:
            remote.running && !motor.running
              ? Math.abs(remote.speed)
              : motor.speed,
        };
      }),
    );
  }, []);

  const requestApi = useCallback(
    async (
      path: string,
      options: RequestInit = {},
      quiet = false,
    ): Promise<ApiStatus> => {
      const run = async () => {
        const baseUrl = activeBaseUrlRef.current || normalizeBaseUrl(deviceAddress);
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        try {
          const headers = new Headers(options.headers);
          if (options.body) headers.set("Content-Type", "application/json");
          if (apiKeyRef.current) headers.set("X-API-Key", apiKeyRef.current);
          const proxyPath = `/api/pico${path}?target=${encodeURIComponent(baseUrl)}`;
          const response = await fetch(proxyPath, {
            ...options,
            headers,
            cache: "no-store",
            signal: controller.signal,
          });
          const status = (await response.json()) as ApiStatus;
          if (!response.ok || !status.ok) {
            throw new Error(status.error || `HTTP ${response.status}`);
          }
          if (!quiet) addLog("rx", `${response.status} ${path}`);
          return status;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error("Picoから12秒以内に応答がありません");
          }
          throw error;
        } finally {
          window.clearTimeout(timeout);
        }
      };
      return run();
    },
    [addLog, deviceAddress],
  );

  const disconnect = useCallback(async () => {
    setReconnectEnabled(false);
    syncRunTokenRef.current += 1;
    commandGenerationRef.current += 1;
    commandIdRef.current = Math.max(commandIdRef.current + 1, Date.now());
    const wasConnected = connectedRef.current;
    connectedRef.current = false;
    if (wasConnected && motorsRef.current.some((motor) => motor.running)) {
      try {
        const headers: Record<string, string> = {
          "X-Command-Id": String(commandIdRef.current),
        };
        if (!udpRealtimeAvailableRef.current) {
          headers["X-Control-Transport"] = "http";
        }
        await requestApi(
          "/api/stop",
          {
            method: "POST",
            headers,
          },
          true,
        );
        addLog("info", "切断前に全モーターを停止しました");
      } catch {
        addLog("error", "停止確認に失敗しました。Pico側ウォッチドッグで自動停止します");
      }
    }
    activeBaseUrlRef.current = "";
    lastHeartbeatSentAtRef.current = 0;
    statusFailureCountRef.current = 0;
    heartbeatFailureCountRef.current = 0;
    connectedRef.current = false;
    setConnected(false);
    setDeviceInfo(null);
    setMotors((current) => current.map((motor) => ({ ...motor, running: false })));
    addLog("info", "LAN接続を終了しました");
  }, [addLog, requestApi]);

  const attemptConnection = useCallback(async (automatic: boolean) => {
    if (connectingRef.current || connectedRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    try {
      const baseUrl = normalizeBaseUrl(deviceAddress);
      activeBaseUrlRef.current = baseUrl;
      window.localStorage.setItem("pico-device-address", deviceAddress.trim());
      window.localStorage.setItem("pico-api-key", apiKey);
      const status = await requestApi("/api/status");
      if (status.udpControlProtocol !== 2) {
        throw new Error(
          `低遅延制御プロトコルv2に未対応です。PicoへFW ${REQUIRED_FIRMWARE_VERSION} 以降を書き込んでください`,
        );
      }
      if ((status.firmwareVersion ?? "") < REQUIRED_FIRMWARE_VERSION) {
        throw new Error(
          `PicoへFW ${REQUIRED_FIRMWARE_VERSION} 以降を書き込んでください。現在のFWは ${status.firmwareVersion ?? "unknown"} です`,
        );
      }
      commandIdRef.current = Math.max(commandIdRef.current + 1, Date.now());
      let controlCheck: ApiStatus | null = null;
      try {
        controlCheck = await requestApi("/api/control-check", {
          method: "POST",
          headers: { "X-Command-Id": String(commandIdRef.current) },
        });
        udpRealtimeAvailableRef.current = true;
      } catch (error) {
        udpRealtimeAvailableRef.current = false;
        addLog(
          "error",
          `UDP制御確認に失敗しました: ${
            error instanceof Error ? error.message : "通信エラー"
          }。HTTP制御モードで接続します`,
        );
      }
      applyStatus({
        ...status,
        motors: controlCheck?.motors ?? status.motors,
        udpCommandSession:
          controlCheck?.udpCommandSession ?? status.udpCommandSession,
      });
      statusFailureCountRef.current = 0;
      heartbeatFailureCountRef.current = 0;
      lastHeartbeatSentAtRef.current = 0;
      connectedRef.current = true;
      setConnected(true);
      addLog(
        "info",
        automatic
          ? `Picoへ再接続しました（${baseUrl}）`
          : `PicoにLAN接続しました（${baseUrl}）`,
      );
    } catch (error) {
      connectedRef.current = false;
      udpRealtimeAvailableRef.current = false;
      setConnected(false);
      if (!automatic) {
        addLog("error", error instanceof Error ? error.message : "接続できませんでした");
      }
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [addLog, apiKey, applyStatus, deviceAddress, requestApi]);

  function connect() {
    setReconnectEnabled(true);
    void attemptConnection(false);
  }

  useEffect(() => {
    if (!reconnectEnabled || connected || connecting) return;
    const timer = window.setTimeout(() => {
      void attemptConnection(true);
    }, RECONNECT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [attemptConnection, connected, connecting, reconnectEnabled]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(async () => {
      if (
        statusPollInFlightRef.current ||
        commandInFlightRef.current > 0 ||
        Date.now() - lastCommandAtRef.current < STATUS_RECONCILE_DELAY_MS
      ) {
        return;
      }
      statusPollInFlightRef.current = true;
      const generation = commandGenerationRef.current;
      try {
        const status = await requestApi("/api/status", {}, true);
        statusFailureCountRef.current = 0;
        if (generation === commandGenerationRef.current) {
          applyStatus(status);
        }
      } catch (error) {
        if (generation !== commandGenerationRef.current) return;
        statusFailureCountRef.current += 1;
        if (statusFailureCountRef.current < STATUS_FAILURE_LIMIT) return;
        statusFailureCountRef.current = 0;
        connectedRef.current = false;
        setConnected(false);
        setDeviceInfo(null);
        setMotors((current) => current.map((motor) => ({ ...motor, running: false })));
        addLog(
          "error",
          `${error instanceof Error ? error.message : "LAN接続が切れました"}。自動再接続します`,
        );
      } finally {
        statusPollInFlightRef.current = false;
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [addLog, applyStatus, connected, requestApi]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(async () => {
      const heartbeatPeriod = udpRealtimeAvailableRef.current
        ? UDP_HEARTBEAT_MS
        : HTTP_HEARTBEAT_MS;
      const now = Date.now();
      if (
        heartbeatInFlightRef.current ||
        !connectedRef.current ||
        commandInFlightRef.current > 0 ||
        now - lastHeartbeatSentAtRef.current < heartbeatPeriod
      ) {
        return;
      }
      lastHeartbeatSentAtRef.current = now;
      heartbeatInFlightRef.current = true;
      const generation = commandGenerationRef.current;
      try {
        const headers: Record<string, string> = {};
        if (!udpRealtimeAvailableRef.current) {
          headers["X-Control-Transport"] = "http";
        }
        await requestApi(
          "/api/heartbeat",
          { method: "POST", headers },
          true,
        );
        heartbeatFailureCountRef.current = 0;
      } catch (error) {
        if (generation !== commandGenerationRef.current) return;
        heartbeatFailureCountRef.current += 1;
        if (heartbeatFailureCountRef.current === 1) {
          addLog(
            "error",
            `安全信号の送信失敗: ${error instanceof Error ? error.message : "通信エラー"}`,
          );
        }
      } finally {
        heartbeatInFlightRef.current = false;
      }
    }, HEARTBEAT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [addLog, connected, requestApi]);

  function updateMotor(index: number, patch: Partial<MotorState>) {
    setMotors((current) =>
      current.map((motor, motorIndex) =>
        motorIndex === index ? { ...motor, ...patch } : motor,
      ),
    );
  }

  function applyOptimisticMotor(index: number, speed: number) {
    const next = motorsRef.current.map((motor, motorIndex) =>
      motorIndex === index
        ? {
            ...motor,
            running: speed !== 0,
            direction:
              speed === 0 ? motor.direction : (speed < 0 ? -1 : 1) as 1 | -1,
            speed: speed === 0 ? motor.speed : Math.abs(speed),
          }
        : motor,
    );
    motorsRef.current = next;
    setMotors(next);
  }

  async function setRemoteMotor(
    index: number,
    speed: number,
  ) {
    if (!connectedRef.current) {
      addLog("error", "先にPicoへLAN接続してください");
      return false;
    }
    syncRunTokenRef.current += 1;
    const generation = ++commandGenerationRef.current;
    commandInFlightRef.current += 1;
    lastCommandAtRef.current = Date.now();
    commandIdRef.current = Math.max(commandIdRef.current + 1, Date.now());
    applyOptimisticMotor(index, speed);
    try {
      addLog("tx", `PUT /api/motors/${index + 1} {"speed":${speed}}`);
      const headers: Record<string, string> = {
        "X-Command-Id": String(commandIdRef.current),
      };
      if (!udpRealtimeAvailableRef.current) {
        headers["X-Control-Transport"] = "http";
      }
      await requestApi(`/api/motors/${index + 1}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ speed }),
      });
      if (generation !== commandGenerationRef.current) return true;
      return true;
    } catch (error) {
      if (generation !== commandGenerationRef.current) return false;
      addLog("error", error instanceof Error ? error.message : "送信に失敗しました");
      return false;
    } finally {
      commandInFlightRef.current -= 1;
    }
  }

  async function runMotor(index: number) {
    const motor = motorsRef.current[index];
    await setRemoteMotor(index, motor.speed * motor.direction);
  }

  async function stopMotor(index: number) {
    await setRemoteMotor(index, 0);
  }

  async function runBothMotors() {
    if (!connectedRef.current) {
      addLog("error", "先にPicoへLAN接続してください");
      return;
    }

    const token = ++syncRunTokenRef.current;
    const generation = ++commandGenerationRef.current;
    commandInFlightRef.current += 1;
    lastCommandAtRef.current = Date.now();
    commandIdRef.current = Math.max(commandIdRef.current + 1, Date.now());
    const snapshot = motorsRef.current.map(
      (motor) => motor.speed * motor.direction,
    );
    const next = motorsRef.current.map((motor, index) => ({
      ...motor,
      running: snapshot[index] !== 0,
      direction: (snapshot[index] < 0 ? -1 : 1) as 1 | -1,
      speed: Math.abs(snapshot[index]),
    }));
    motorsRef.current = next;
    setMotors(next);
    addLog(
      "tx",
      `PUT /api/motors/sync {"speed1":${snapshot[0]},"speed2":${snapshot[1]}}`,
    );

    try {
      const headers: Record<string, string> = {
        "X-Command-Id": String(commandIdRef.current),
      };
      if (!udpRealtimeAvailableRef.current) {
        headers["X-Control-Transport"] = "http";
      }
      await requestApi("/api/motors/sync", {
        method: "PUT",
        headers,
        body: JSON.stringify({ speed1: snapshot[0], speed2: snapshot[1] }),
      });
      if (generation !== commandGenerationRef.current) return;
      if (
        token === syncRunTokenRef.current &&
        generation === commandGenerationRef.current
      ) {
        addLog("info", "同期命令1回で2台のモーターを開始しました");
      }
    } catch (error) {
      if (generation !== commandGenerationRef.current) return;
      addLog("error", error instanceof Error ? error.message : "同期命令に失敗しました");
    } finally {
      commandInFlightRef.current -= 1;
    }
  }

  async function emergencyStop() {
    if (!connectedRef.current) return;
    syncRunTokenRef.current += 1;
    const generation = ++commandGenerationRef.current;
    commandInFlightRef.current += 1;
    lastCommandAtRef.current = Date.now();
    commandIdRef.current = Math.max(commandIdRef.current + 1, Date.now());
    const stopped = motorsRef.current.map((motor) => ({
      ...motor,
      running: false,
    }));
    motorsRef.current = stopped;
    setMotors(stopped);
    try {
      addLog("tx", "POST /api/stop");
      const headers: Record<string, string> = {
        "X-Command-Id": String(commandIdRef.current),
      };
      if (!udpRealtimeAvailableRef.current) {
        headers["X-Control-Transport"] = "http";
      }
      await requestApi("/api/stop", {
        method: "POST",
        headers,
      });
      if (generation !== commandGenerationRef.current) return;
    } catch (error) {
      if (generation !== commandGenerationRef.current) return;
      addLog("error", error instanceof Error ? error.message : "停止命令に失敗しました");
    } finally {
      commandInFlightRef.current -= 1;
    }
  }

  async function submitRawCommand(event: FormEvent) {
    event.preventDefault();
    const match = rawCommand.trim().match(/^0x10([01])\s*,\s*(-?\d+)$/i);
    if (!match) {
      addLog("error", "形式は 0x100,800 または 0x101,-800 です");
      return;
    }
    const speed = Number(match[2]);
    if (!Number.isInteger(speed) || Math.abs(speed) > MAX_SPEED) {
      addLog("error", `速度は -${MAX_SPEED}〜${MAX_SPEED} の整数です`);
      return;
    }
    if (await setRemoteMotor(Number(match[1]), speed)) setRawCommand("");
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Pico Stepper Console ホーム">
          <span className="brandMark" aria-hidden="true"><i /><i /><i /></span>
          <span>PICO STEPPER <b>LAN CONSOLE</b></span>
        </a>
        <div className={`connectionPill ${connected ? "isConnected" : ""}`}>
          <span className="statusDot" />
          {connected ? `${deviceInfo?.ip ?? deviceAddress} 接続中` : "未接続"}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">ETHERNET MOTION CONTROL / W5500 HTTP API</p>
          <h1>LANから、<br /><em>モーターを制御。</em></h1>
          <p className="heroCopy">
            W5500を接続したRaspberry Pi PicoへHTTP APIで命令を送り、
            2台のステップモーターの速度と方向を制御します。
            DHCPとmDNSにより、接続するPCやLANが変わっても同じホスト名で接続できます。
          </p>
        </div>
        <div className="connectPanel lanPanel">
          <div className="lanGraphic" aria-hidden="true">
            <span className="ethernetJack">LAN</span><span className="usbLine" />
            <span className="board">PICO<span>W5500</span></span>
          </div>
          <label className="connectField">
            <span>PICO HOST（通常は変更不要）</span>
            <input
              value={deviceAddress}
              onChange={(event) => setDeviceAddress(event.target.value)}
              disabled={connected}
              inputMode="url"
              placeholder="pico-motor.local"
            />
          </label>
          <label className="connectField">
            <span>API KEY（設定した場合のみ）</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={connected}
              autoComplete="off"
              placeholder="未設定"
            />
          </label>
          <button
            className={connected ? "button secondary" : "button primary"}
            onClick={connected ? disconnect : connect}
            disabled={connecting}
          >
            <span aria-hidden="true">{connected ? "×" : "↗"}</span>
            {connecting ? "接続しています…" : connected ? "LANを切断" : "Picoへ接続"}
          </button>
          <small>接続先: http://pico-motor.local ・ 初回起動は最大15秒</small>
        </div>
      </section>

      <section className="workspace" aria-label="モーター操作">
        <div className="sectionHeading">
          <div>
            <span>CONTROL DECK</span>
            <h2>モーター操作</h2>
            {deviceInfo && (
              <p className="deviceMeta">
                {deviceInfo.hostname ?? DEFAULT_DEVICE} → {deviceInfo.ip}（
                {deviceInfo.networkMode === "link-local" ? "PC直結" : "DHCP"}）・
                FW {deviceInfo.firmwareVersion ?? "unknown"}・
                UDP RT v{deviceInfo.udpControlProtocol}・
                UDP cmd {deviceInfo.urgentCommands ?? 0}・
                keepalive {deviceInfo.safetyKeepalives ?? 0}・
                API watchdog {deviceInfo.watchdogMs / 1000}s
                {(deviceInfo.socketCommandTimeouts ?? 0) > 0 &&
                  `・W5500自動復旧 ${deviceInfo.socketCommandTimeouts}回`}
              </p>
            )}
          </div>
          <div className="deckActions">
            <button
              className="syncRun"
              onPointerDown={(event) => {
                if (event.button === 0) void runBothMotors();
              }}
              onClick={(event) => {
                if (event.detail === 0) void runBothMotors();
              }}
              disabled={!connected}
            >
              <span aria-hidden="true">▶▶</span>
              2台同時回転
            </button>
            <button
              className="emergency"
              onPointerDown={(event) => {
                if (event.button === 0) void emergencyStop();
              }}
              onClick={(event) => {
                if (event.detail === 0) void emergencyStop();
              }}
              disabled={!connected}
            >
              <span aria-hidden="true">■</span> 2台同時停止
            </button>
          </div>
        </div>

        <div className="motorGrid">
          {motors.map((motor, index) => (
            <article className="motorCard" key={motor.id}>
              <div className="motorHeader">
                <div>
                  <span>MOTOR {index + 1}</span>
                  <h3>{index === 0 ? "X AXIS" : "Y AXIS"}</h3>
                </div>
                <code>{motor.id}</code>
              </div>

              <div className={`motorStatus ${motor.running ? "running" : ""}`}>
                <span className="motorIcon" aria-hidden="true">◎</span>
                <div>
                  <b>{motor.running ? "RUNNING" : "STANDBY"}</b>
                  <small>
                    {motor.running
                      ? `${motor.direction > 0 ? "正転" : "逆転"} / ${motor.speed.toLocaleString()} steps/s`
                      : "停止中"}
                  </small>
                </div>
              </div>

              <label className="fieldLabel" htmlFor={`speed-${index}`}>
                速度 <span>STEPS / SEC</span>
              </label>
              <div className="speedInput">
                <input
                  id={`speed-${index}`}
                  type="number"
                  min="1"
                  max={MAX_SPEED}
                  value={motor.speed}
                  onChange={(event) =>
                    updateMotor(index, {
                      speed: Math.min(MAX_SPEED, Math.max(1, Number(event.target.value) || 1)),
                    })
                  }
                />
                <span>steps/s</span>
              </div>
              <input
                className="range"
                aria-label={`モーター${index + 1}の速度`}
                type="range"
                min="1"
                max={MAX_SPEED}
                step="1"
                value={motor.speed}
                onChange={(event) => updateMotor(index, { speed: Number(event.target.value) })}
              />
              <div className="rangeLabels"><span>1</span><span>20,000</span></div>

              <span className="fieldLabel">回転方向 <span>DIRECTION</span></span>
              <div className="directionGroup" role="group" aria-label={`モーター${index + 1}の回転方向`}>
                <button className={motor.direction === 1 ? "active" : ""} onClick={() => updateMotor(index, { direction: 1 })}>↻ 正転</button>
                <button className={motor.direction === -1 ? "active" : ""} onClick={() => updateMotor(index, { direction: -1 })}>↺ 逆転</button>
              </div>

              <div className="motorActions">
                <button
                  className="button run"
                  onPointerDown={(event) => {
                    if (event.button === 0) void runMotor(index);
                  }}
                  onClick={(event) => {
                    if (event.detail === 0) void runMotor(index);
                  }}
                  disabled={!connected}
                >
                  ▶ 動作開始
                </button>
                <button
                  className="button stop"
                  onPointerDown={(event) => {
                    if (event.button === 0) void stopMotor(index);
                  }}
                  onClick={(event) => {
                    if (event.detail === 0) void stopMotor(index);
                  }}
                  disabled={!connected}
                >
                  ■ 停止
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="consoleSection">
        <div className="consoleHeader">
          <div><span>LIVE CONTROL</span><h2>制御通信ログ</h2></div>
          <button onClick={() => setLogs([])}>ログを消去</button>
        </div>
        <div className="consoleBody" role="log" aria-live="polite">
          {logs.length === 0 ? (
            <p className="emptyLog"><span>_</span> Picoへ接続すると通信ログが表示されます。</p>
          ) : logs.map((log) => (
            <p key={log.id} className={log.kind}>
              <time>{log.time}</time>
              <b>{log.kind === "tx" ? "TX →" : log.kind === "rx" ? "RX ←" : log.kind === "error" ? "ERR" : "SYS"}</b>
              <span>{log.message}</span>
            </p>
          ))}
        </div>
        <form className="rawCommand" onSubmit={submitRawCommand}>
          <label htmlFor="raw">RAW COMMAND</label>
          <input id="raw" value={rawCommand} onChange={(event) => setRawCommand(event.target.value)} placeholder="0x100,800" />
          <button type="submit" disabled={!connected}>API送信 ↵</button>
        </form>
      </section>

      <footer>
        <p><b>安全機能</b> UDPでは250ms周期、HTTP制御モードでは750ms周期の安全信号を送り、3秒途絶えるとPicoがモーターを自動停止します。</p>
        <p>W5500 <span>•</span> DHCP <span>•</span> mDNS</p>
      </footer>
    </main>
  );
}
