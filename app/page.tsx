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
  motors: ApiMotor[];
  maxSpeed: number;
  watchdogMs: number;
  apiKeyRequired: boolean;
  error?: string;
};

const MAX_SPEED = 20000;
const DEFAULT_DEVICE = "192.168.1.50";
const HEARTBEAT_MS = 3000;

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
  if (!trimmed) throw new Error("PicoのIPアドレスを入力してください");
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
  const [deviceInfo, setDeviceInfo] = useState<ApiStatus | null>(null);
  const [motors, setMotors] = useState<MotorState[]>([
    { id: "0x100", speed: 800, direction: 1, running: false },
    { id: "0x101", speed: 800, direction: 1, running: false },
  ]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [rawCommand, setRawCommand] = useState("");

  const logIdRef = useRef(0);
  const motorsRef = useRef(motors);
  const connectedRef = useRef(connected);
  const activeBaseUrlRef = useRef("");
  const apiKeyRef = useRef(apiKey);
  const requestChainRef = useRef<Promise<void>>(Promise.resolve());

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
      if (savedAddress) setDeviceAddress(savedAddress);
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
        const timeout = window.setTimeout(() => controller.abort(), 2500);
        try {
          const headers = new Headers(options.headers);
          if (options.body) headers.set("Content-Type", "application/json");
          if (apiKeyRef.current) headers.set("X-API-Key", apiKeyRef.current);
          const response = await fetch(`${baseUrl}${path}`, {
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
            throw new Error("Picoから2.5秒以内に応答がありません");
          }
          throw error;
        } finally {
          window.clearTimeout(timeout);
        }
      };
      const result = requestChainRef.current.then(run, run);
      requestChainRef.current = result.then(() => undefined, () => undefined);
      return result;
    },
    [addLog, deviceAddress],
  );

  const disconnect = useCallback(async () => {
    if (connectedRef.current && motorsRef.current.some((motor) => motor.running)) {
      try {
        await requestApi("/api/stop", { method: "POST" }, true);
        addLog("info", "切断前に全モーターを停止しました");
      } catch {
        addLog("error", "停止確認に失敗しました。Pico側ウォッチドッグで自動停止します");
      }
    }
    activeBaseUrlRef.current = "";
    connectedRef.current = false;
    setConnected(false);
    setDeviceInfo(null);
    setMotors((current) => current.map((motor) => ({ ...motor, running: false })));
    addLog("info", "LAN接続を終了しました");
  }, [addLog, requestApi]);

  async function connect() {
    setConnecting(true);
    try {
      const baseUrl = normalizeBaseUrl(deviceAddress);
      activeBaseUrlRef.current = baseUrl;
      window.localStorage.setItem("pico-device-address", deviceAddress.trim());
      window.localStorage.setItem("pico-api-key", apiKey);
      const status = await requestApi("/api/status");
      applyStatus(status);
      connectedRef.current = true;
      setConnected(true);
      addLog("info", `PicoにLAN接続しました（${baseUrl}）`);
    } catch (error) {
      activeBaseUrlRef.current = "";
      setConnected(false);
      addLog("error", error instanceof Error ? error.message : "接続できませんでした");
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(async () => {
      try {
        const status = await requestApi("/api/status", {}, true);
        applyStatus(status);
      } catch (error) {
        connectedRef.current = false;
        setConnected(false);
        setDeviceInfo(null);
        setMotors((current) => current.map((motor) => ({ ...motor, running: false })));
        addLog("error", error instanceof Error ? error.message : "LAN接続が切れました");
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [addLog, applyStatus, connected, requestApi]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(async () => {
      const running = motorsRef.current
        .map((motor, index) => ({ motor, index }))
        .filter(({ motor }) => motor.running);
      try {
        for (const { motor, index } of running) {
          const speed = motor.speed * motor.direction;
          await requestApi(
            `/api/motors/${index + 1}`,
            { method: "PUT", body: JSON.stringify({ speed }) },
            true,
          );
        }
      } catch (error) {
        addLog(
          "error",
          `ウォッチドッグ更新失敗: ${error instanceof Error ? error.message : "通信エラー"}`,
        );
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [addLog, connected, requestApi]);

  function updateMotor(index: number, patch: Partial<MotorState>) {
    setMotors((current) =>
      current.map((motor, motorIndex) =>
        motorIndex === index ? { ...motor, ...patch } : motor,
      ),
    );
  }

  async function setRemoteMotor(index: number, speed: number) {
    if (!connectedRef.current) {
      addLog("error", "先にPicoへLAN接続してください");
      return false;
    }
    try {
      addLog("tx", `PUT /api/motors/${index + 1} {"speed":${speed}}`);
      const status = await requestApi(`/api/motors/${index + 1}`, {
        method: "PUT",
        body: JSON.stringify({ speed }),
      });
      applyStatus(status);
      return true;
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : "送信に失敗しました");
      return false;
    }
  }

  async function runMotor(index: number) {
    const motor = motorsRef.current[index];
    await setRemoteMotor(index, motor.speed * motor.direction);
  }

  async function stopMotor(index: number) {
    await setRemoteMotor(index, 0);
  }

  async function emergencyStop() {
    if (!connectedRef.current) return;
    try {
      addLog("tx", "POST /api/stop");
      const status = await requestApi("/api/stop", { method: "POST" });
      applyStatus(status);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : "停止命令に失敗しました");
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
            通信が途絶えるとPico側のウォッチドッグが自動停止します。
          </p>
        </div>
        <div className="connectPanel lanPanel">
          <div className="lanGraphic" aria-hidden="true">
            <span className="ethernetJack">LAN</span><span className="usbLine" />
            <span className="board">PICO<span>W5500</span></span>
          </div>
          <label className="connectField">
            <span>PICO IP / HOST</span>
            <input
              value={deviceAddress}
              onChange={(event) => setDeviceAddress(event.target.value)}
              disabled={connected}
              inputMode="url"
              placeholder={DEFAULT_DEVICE}
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
          <small>PCとPicoを同じLANに接続してください</small>
        </div>
      </section>

      <section className="workspace" aria-label="モーター操作">
        <div className="sectionHeading">
          <div>
            <span>CONTROL DECK</span>
            <h2>モーター操作</h2>
            {deviceInfo && (
              <p className="deviceMeta">
                API watchdog {deviceInfo.watchdogMs / 1000}s ・ 最大 {deviceInfo.maxSpeed.toLocaleString()} steps/s
              </p>
            )}
          </div>
          <button className="emergency" onClick={emergencyStop} disabled={!connected}>
            <span aria-hidden="true">■</span> すべて停止
          </button>
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
                <button className="button run" onClick={() => runMotor(index)} disabled={!connected}>▶ 動作開始</button>
                <button className="button stop" onClick={() => stopMotor(index)} disabled={!connected}>■ 停止</button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="consoleSection">
        <div className="consoleHeader">
          <div><span>LIVE HTTP</span><h2>API通信ログ</h2></div>
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
        <p><b>安全機能</b> ブラウザからの更新が10秒間途絶えると、Picoがモーターを自動停止します。</p>
        <p>W5500 <span>•</span> HTTP API <span>•</span> STATIC IP</p>
      </footer>
    </main>
  );
}
