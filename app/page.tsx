"use client";

import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type SerialPortLike = EventTarget & {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
};

type SerialNavigator = Navigator & {
  serial?: EventTarget & {
    requestPort(): Promise<SerialPortLike>;
  };
};

type LogItem = {
  id: number;
  time: string;
  kind: "tx" | "rx" | "info" | "error";
  message: string;
};

type MotorState = {
  speed: number;
  direction: 1 | -1;
  running: boolean;
};

const MOTOR_IDS = ["0x100", "0x101"] as const;
const MAX_SPEED = 20000;

function nowLabel() {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export default function Home() {
  const supported = useSyncExternalStore<boolean | null>(
    () => () => undefined,
    () => "serial" in navigator,
    () => null,
  );
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [motors, setMotors] = useState<MotorState[]>([
    { speed: 800, direction: 1, running: false },
    { speed: 800, direction: 1, running: false },
  ]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [rawCommand, setRawCommand] = useState("");

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readLoopRef = useRef<Promise<void> | null>(null);
  const logIdRef = useRef(0);

  const addLog = useCallback((kind: LogItem["kind"], message: string) => {
    setLogs((current) => [
      ...current.slice(-99),
      { id: ++logIdRef.current, time: nowLabel(), kind, message },
    ]);
  }, []);

  const disconnect = useCallback(async () => {
    const writer = writerRef.current;
    if (writer) {
      try {
        await writer.write(
          new TextEncoder().encode(`${MOTOR_IDS[0]},0\n${MOTOR_IDS[1]},0\n`),
        );
        addLog("tx", `${MOTOR_IDS[0]},0`);
        addLog("tx", `${MOTOR_IDS[1]},0`);
      } catch {
        addLog("error", "切断前の停止コマンドを送信できませんでした");
      }
    }

    const reader = readerRef.current;
    readerRef.current = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The device may already be gone.
      }
      reader.releaseLock();
    }

    try {
      await readLoopRef.current;
    } catch {
      // Read errors are already shown in the console.
    }
    readLoopRef.current = null;

    if (writerRef.current) {
      writerRef.current.releaseLock();
      writerRef.current = null;
    }

    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch {
        // Ignore close errors after a physical disconnect.
      }
      portRef.current = null;
    }

    setConnected(false);
    setMotors((current) => current.map((motor) => ({ ...motor, running: false })));
    addLog("info", "USBポートを切断しました");
  }, [addLog]);

  useEffect(() => {
    return () => {
      const reader = readerRef.current;
      readerRef.current = null;
      void reader?.cancel();
      writerRef.current?.releaseLock();
      writerRef.current = null;
      void portRef.current?.close();
      portRef.current = null;
    };
  }, []);

  async function connect() {
    if (!("serial" in navigator)) return;
    setConnecting(true);
    try {
      const serial = (navigator as SerialNavigator).serial;
      if (!serial) throw new Error("Web Serial APIが利用できません");

      const port = await serial.requestPort();
      await port.open({ baudRate: 115200, bufferSize: 4096 });
      portRef.current = port;
      if (!port.readable || !port.writable) {
        await port.close();
        portRef.current = null;
        throw new Error("ポートの読み書きを開始できませんでした");
      }

      writerRef.current = port.writable.getWriter();
      const reader = port.readable.getReader();
      readerRef.current = reader;
      setConnected(true);
      addLog("info", "Raspberry Pi Picoに接続しました（115200 baud）");

      readLoopRef.current = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            lines.filter(Boolean).forEach((line) => addLog("rx", line));
          }
        } catch (error) {
          if (readerRef.current) {
            addLog("error", error instanceof Error ? error.message : "受信エラー");
          }
        } finally {
          // When the cable is unplugged, return the UI to a safe stopped state.
          if (readerRef.current === reader) {
            reader.releaseLock();
            readerRef.current = null;
            writerRef.current?.releaseLock();
            writerRef.current = null;
            portRef.current = null;
            setConnected(false);
            setMotors((current) => current.map((motor) => ({ ...motor, running: false })));
            addLog("info", "USB接続が終了しました");
          }
        }
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message : "接続できませんでした";
      if (message.toLowerCase().includes("no port selected")) {
        addLog("info", "ポート選択をキャンセルしました");
      } else {
        addLog("error", message);
      }
    } finally {
      setConnecting(false);
    }
  }

  async function sendCommand(command: string) {
    const writer = writerRef.current;
    if (!writer || !connected) {
      addLog("error", "先にPicoへ接続してください");
      return false;
    }

    try {
      await writer.write(new TextEncoder().encode(`${command}\n`));
      addLog("tx", command);
      return true;
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : "送信に失敗しました");
      return false;
    }
  }

  function updateMotor(index: number, patch: Partial<MotorState>) {
    setMotors((current) =>
      current.map((motor, motorIndex) =>
        motorIndex === index ? { ...motor, ...patch } : motor,
      ),
    );
  }

  async function runMotor(index: number) {
    const motor = motors[index];
    const signedSpeed = motor.speed * motor.direction;
    if (await sendCommand(`${MOTOR_IDS[index]},${signedSpeed}`)) {
      updateMotor(index, { running: true });
    }
  }

  async function stopMotor(index: number) {
    if (await sendCommand(`${MOTOR_IDS[index]},0`)) {
      updateMotor(index, { running: false });
    }
  }

  async function emergencyStop() {
    const first = await sendCommand(`${MOTOR_IDS[0]},0`);
    const second = await sendCommand(`${MOTOR_IDS[1]},0`);
    if (first && second) {
      setMotors((current) => current.map((motor) => ({ ...motor, running: false })));
    }
  }

  async function submitRawCommand(event: FormEvent) {
    event.preventDefault();
    const command = rawCommand.trim();
    const match = command.match(/^(0x10[01])\s*,\s*(-?\d+)$/i);
    if (!match) {
      addLog("error", "形式は 0x100,800 または 0x101,-800 です");
      return;
    }

    const speed = Number(match[2]);
    if (!Number.isSafeInteger(speed) || Math.abs(speed) > MAX_SPEED) {
      addLog("error", `速度は -${MAX_SPEED.toLocaleString()}〜${MAX_SPEED.toLocaleString()} の整数で指定してください`);
      return;
    }

    const normalizedCommand = `${match[1].toLowerCase()},${speed}`;
    if (await sendCommand(normalizedCommand)) setRawCommand("");
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Pico Stepper Console ホーム">
          <span className="brandMark" aria-hidden="true"><i /><i /><i /></span>
          <span>PICO STEPPER <b>CONSOLE</b></span>
        </a>
        <div className={`connectionPill ${connected ? "isConnected" : ""}`} role="status" aria-live="polite">
          <span className="statusDot" aria-hidden="true" />
          {connecting ? "接続処理中" : connected ? "接続中" : "未接続"}
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">USB MOTION CONTROL / WEB SERIAL</p>
          <h1>ブラウザから、<br /><em>一歩ずつ確かめる。</em></h1>
          <p className="heroCopy">
            Raspberry Pi PicoをUSBで接続し、2台のステップモーターへ速度と方向を直接送信します。
            インストール不要。テストベンチを、すぐに動かせます。
          </p>
        </div>
        <div className="connectPanel">
          <div className="usbGraphic" aria-hidden="true">
            <span className="usbPlug" /><span className="usbLine" /><span className="board">PICO<span>USB</span></span>
          </div>
          {supported === false ? (
            <div className="browserWarning">
              <strong>このブラウザはWeb Serial非対応です</strong>
              <span>PC版のGoogle ChromeまたはMicrosoft Edgeで開いてください。</span>
            </div>
          ) : (
            <>
              <button
                className={connected ? "button secondary" : "button primary"}
                onClick={connected ? disconnect : connect}
                disabled={connecting || supported === null}
              >
                {connecting ? "接続しています…" : connected ? "USBを切断" : "USBポートを選択"}
              </button>
              <small>通信速度 115200 baud ・ データは端末内で処理されます</small>
            </>
          )}
        </div>
      </section>

      <section className="workspace" aria-label="モーター操作">
        <div className="sectionHeading">
          <div><span>CONTROL DECK</span><h2>モーター動作確認</h2></div>
          <button className="emergency" onClick={emergencyStop} disabled={!connected}>
            すべて停止
          </button>
        </div>

        <div className="motorGrid">
          {motors.map((motor, index) => (
            <article className="motorCard" key={MOTOR_IDS[index]}>
              <div className="motorHeader">
                <div><span>MOTOR {index + 1}</span><h3>{index === 0 ? "X AXIS" : "Y AXIS"}</h3></div>
                <code>{MOTOR_IDS[index]}</code>
              </div>

              <div className={`motorStatus ${motor.running ? "running" : ""}`}>
                <span className="motorIcon" aria-hidden="true" />
                <div><b>{motor.running ? "RUNNING" : "STANDBY"}</b><small>{motor.running ? `${motor.direction > 0 ? "正転" : "逆転"} / ${motor.speed.toLocaleString()} steps/s` : "停止中"}</small></div>
              </div>

              <label className="fieldLabel" htmlFor={`speed-${index}`}>速度 <span>STEPS / SEC</span></label>
              <div className="speedInput">
                <input
                  id={`speed-${index}`}
                  type="number"
                  min="1"
                  max={MAX_SPEED}
                  value={motor.speed}
                  disabled={motor.running}
                  onChange={(event) => updateMotor(index, { speed: Math.min(MAX_SPEED, Math.max(1, Number(event.target.value) || 1)) })}
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
                disabled={motor.running}
                onChange={(event) => updateMotor(index, { speed: Number(event.target.value) })}
              />
              <div className="rangeLabels"><span>1</span><span>20,000</span></div>

              <span className="fieldLabel">回転方向 <span>DIRECTION</span></span>
              <div className="directionGroup" role="group" aria-label={`モーター${index + 1}の回転方向`}>
                <button className={motor.direction === 1 ? "active" : ""} onClick={() => updateMotor(index, { direction: 1 })} disabled={motor.running}>正転</button>
                <button className={motor.direction === -1 ? "active" : ""} onClick={() => updateMotor(index, { direction: -1 })} disabled={motor.running}>逆転</button>
              </div>

              <div className="motorActions">
                <button className="button run" onClick={() => runMotor(index)} disabled={!connected}>動作開始</button>
                <button className="button stop" onClick={() => stopMotor(index)} disabled={!connected}>停止</button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="consoleSection">
        <div className="consoleHeader">
          <div><span>LIVE SERIAL</span><h2>通信ログ</h2></div>
          <button onClick={() => setLogs([])}>ログを消去</button>
        </div>
        <div className="consoleBody" role="log" aria-live="polite">
          {logs.length === 0 ? (
            <p className="emptyLog"><span>_</span> USBポートを選択すると通信ログが表示されます。</p>
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
          <button type="submit" disabled={!connected}>送信</button>
        </form>
      </section>

      <footer>
        <p><b>接続のヒント</b> PicoにUSB CDC対応ファームウェアを書き込み、データ通信対応USBケーブルを使用してください。</p>
        <p>MAX 20,000 steps/s <span>•</span> Chrome / Edge <span>•</span> HTTPS</p>
      </footer>
    </main>
  );
}
