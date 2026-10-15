/**
 * The left rail: workspace selector and the run history of the current
 * workspace, read from its own `.tinycode` store. Clicking a run opens the
 * read-only replay.
 */

import { memo } from "react";
import type { Run } from "tinycode/dist/core/contracts.js";

export const STATUS_LABEL: Record<Run["status"], string> = {
  queued: "排队中",
  running: "运行中",
  awaiting_human: "等待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const HistoryPanel = memo(function HistoryPanel({
  workspace,
  runs,
  selectedRunId,
  onSelectRun,
  onPickWorkspace,
  onBackToLive,
}: {
  workspace: string;
  runs: readonly Run[];
  selectedRunId: string | undefined;
  onSelectRun: (runId: string) => void;
  onPickWorkspace: () => void;
  onBackToLive: () => void;
}) {
  const workspaceName = workspace === "" ? "未选择工作区" : basename(workspace);
  return (
    <aside className="sidebar">
      <div className="workspace">
        <p className="workspace-name" title={workspace} data-testid="workspace-name">
          {workspaceName}
        </p>
        <button type="button" className="button button-ghost" onClick={onPickWorkspace}>
          更换…
        </button>
        <button type="button" className="button button-ghost" onClick={onBackToLive} data-testid="live-button">
          实时视图
        </button>
      </div>

      <h2 className="sidebar-heading">运行记录</h2>
      {runs.length === 0 ? (
        <p className="sidebar-empty">此工作区还没有运行记录。</p>
      ) : (
        <ul className="run-list" aria-label="Run history">
          {runs.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                className={`run-item${run.runId === selectedRunId ? " run-item-active" : ""}`}
                onClick={() => onSelectRun(run.runId)}
                data-testid="history-run"
                data-status={run.status}
                title={run.task.input}
              >
                <span className={`run-status run-status-${run.status}`}>
                  {STATUS_LABEL[run.status]}
                </span>
                <span className="run-task">{run.task.input}</span>
                <span className="run-time">{relativeTime(run.startedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
});

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}
