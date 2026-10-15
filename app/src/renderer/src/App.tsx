/**
 * The composition root: one subscription to the host, functional state
 * updates throughout, and derived values computed during render. The live
 * timeline and the history replay share the same fold, so they cannot disagree.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "tinycode/dist/core/contracts.js";
import type { HostMessage, HostRunInfo } from "../../shared/protocol.ts";
import { ApprovalDialog, type PendingRequest } from "./components/ApprovalDialog.tsx";
import { HistoryPanel, STATUS_LABEL } from "./components/HistoryPanel.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { foldAll, foldEvent, type TimelineItem } from "./timeline.ts";

interface HistoryDetail {
  run: Run;
  items: TimelineItem[];
}

const MAX_HOST_ERRORS = 4;

export function App() {
  const [workspace, setWorkspace] = useState("");
  const [fakeMode, setFakeMode] = useState(false);
  const [task, setTask] = useState("");
  const [runActive, setRunActive] = useState(false);
  const [items, setItems] = useState<readonly TimelineItem[]>([]);
  const [pending, setPending] = useState<PendingRequest | undefined>(undefined);
  const [runInfo, setRunInfo] = useState<HostRunInfo | undefined>(undefined);
  const [hostErrors, setHostErrors] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [history, setHistory] = useState<HistoryDetail | undefined>(undefined);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  // One subscription for the app's lifetime; every branch uses functional
  // updates so the listener never needs to resubscribe.
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.tinycode.onHostMessage((message: HostMessage) => {
      if (disposed) return;
      switch (message.kind) {
        case "event":
          setItems((prev) => foldEvent(prev, message.event));
          break;
        case "human-input-request":
          setPending({ requestId: message.requestId, question: message.question });
          break;
        case "run-info":
          setRunInfo(message.info);
          break;
        case "run-active":
          setRunActive(message.active);
          if (!message.active) {
            setPending(undefined);
            setTask("");
          }
          break;
        case "host-error":
          setHostErrors((prev) => [...prev.slice(-(MAX_HOST_ERRORS - 1)), message.message]);
          break;
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Initial workspace: the host picks it (env override or home directory).
  useEffect(() => {
    void window.tinycode.getInitialState().then((result) => {
      if (!result.ok) return;
      setWorkspace(result.data.workspace);
      setFakeMode(result.data.fakeMode);
    });
  }, []);

  const refreshRuns = useCallback((cwd: string): void => {
    if (cwd === "") return;
    void window.tinycode.listRuns(cwd).then((result) => {
      if (result.ok) {
        setRuns([...result.data].sort((a, b) => b.startedAt - a.startedAt));
      } else {
        setHostErrors((prev) => [...prev.slice(-(MAX_HOST_ERRORS - 1)), result.error]);
      }
    });
  }, []);

  useEffect(() => {
    refreshRuns(workspace);
  }, [workspace, refreshRuns]);

  // Reload history when a run ends; keep the timeline pinned to the newest event.
  useEffect(() => {
    if (!runActive) refreshRuns(workspace);
  }, [runActive, workspace, refreshRuns]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items.length]);

  const startRun = (): void => {
    if (task.trim() === "" || workspace === "" || runActive) return;
    setStartError(undefined);
    setHistory(undefined);
    setItems([]);
    setRunInfo(undefined);
    void window.tinycode.startRun(task, workspace).then((result) => {
      if (!result.ok) setStartError(result.error);
    });
  };

  const cancelRun = (): void => {
    void window.tinycode.cancelRun().then((result) => {
      if (!result.ok) setHostErrors((prev) => [...prev.slice(-(MAX_HOST_ERRORS - 1)), result.error]);
    });
  };

  const answerHuman = (value: unknown): void => {
    if (pending === undefined) return;
    const requestId = pending.requestId;
    setPending(undefined);
    void window.tinycode.answerHuman(requestId, value);
  };

  const pickWorkspace = (): void => {
    void window.tinycode.pickWorkspace().then((result) => {
      if (result.ok && result.data !== null) setWorkspace(result.data);
    });
  };

  const openRun = (runId: string): void => {
    void window.tinycode.loadRun(workspace, runId).then((result) => {
      if (result.ok) {
        setHistory({ run: result.data.run, items: foldAll(result.data.events) });
      } else {
        setHostErrors((prev) => [...prev.slice(-(MAX_HOST_ERRORS - 1)), result.error]);
      }
    });
  };

  const canRun = task.trim() !== "" && workspace !== "" && !runActive;

  return (
    <div className="app">
      <header className="app-header">
        <span className="wordmark">TinyCode</span>
        {fakeMode && <span className="chip chip-fake">模拟驱动</span>}
        <span className="header-meta">{runInfo?.modelLabel ?? "尚未运行"}</span>
      </header>

      <div className="app-body">
        <HistoryPanel
          workspace={workspace}
          runs={runs}
          selectedRunId={history?.run.runId}
          onSelectRun={openRun}
          onPickWorkspace={pickWorkspace}
          onBackToLive={() => setHistory(undefined)}
        />

        <main className="main">
          {history === undefined ? (
            <>
              <section className="composer" aria-label="Task">
                <textarea
                  className="task-input"
                  placeholder="描述要交给 Agent 的任务…"
                  value={task}
                  rows={2}
                  onChange={(event) => setTask(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) startRun();
                  }}
                  disabled={runActive}
                  data-testid="task-input"
                />
                {runActive ? (
                  <button type="button" className="button button-danger" onClick={cancelRun} data-testid="cancel-button">
                    取消运行
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={startRun}
                    disabled={!canRun}
                    data-testid="run-button"
                  >
                    运行
                  </button>
                )}
              </section>

              {startError !== undefined && (
                <p className="host-error" role="alert" data-testid="start-error">
                  启动失败：{startError}
                </p>
              )}
              {hostErrors.length > 0 && (
                <div className="host-error" role="alert">
                  {hostErrors.map((message, index) => (
                    <p key={index}>{message}</p>
                  ))}
                </div>
              )}

              <Timeline
                items={items}
                emptyHint="还没有事件。选择工作区，描述任务，然后运行。"
              />
              <div ref={bottomRef} />
            </>
          ) : (
            <section className="replay" aria-label="Run replay">
              <div className="replay-head">
                <button type="button" className="button button-ghost" onClick={() => setHistory(undefined)}>
                  ← 返回实时
                </button>
                <span className={`run-status run-status-${history.run.status}`}>
                  {STATUS_LABEL[history.run.status]}
                </span>
                <span className="replay-task" title={history.run.task.input}>
                  {history.run.task.input}
                </span>
              </div>
              <Timeline items={history.items} emptyHint="该运行没有记录事件。" />
            </section>
          )}
        </main>

        {pending !== undefined && <ApprovalDialog request={pending} onAnswer={answerHuman} />}
      </div>
    </div>
  );
}
