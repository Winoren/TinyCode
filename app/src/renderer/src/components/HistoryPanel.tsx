/**
 * The left rail: workspace selector and the run history of the current
 * workspace, read from its own `.tinycode` store. Clicking a run opens the
 * read-only replay.
 */

import { memo } from "react";
import type { Run } from "tinycode/dist/core/contracts.js";

const STATUS_LABEL: Record<Run["status"], string> = {
  queued: "queued",
  running: "running",
  awaiting_human: "waiting",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
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
  const workspaceName = workspace === "" ? "no workspace" : basename(workspace);
  return (
    <aside className="sidebar">
      <div className="workspace">
        <p className="workspace-name" title={workspace} data-testid="workspace-name">
          {workspaceName}
        </p>
        <button type="button" className="button button-ghost" onClick={onPickWorkspace}>
          Change…
        </button>
        <button type="button" className="button button-ghost" onClick={onBackToLive} data-testid="live-button">
          Live view
        </button>
      </div>

      <h2 className="sidebar-heading">Runs</h2>
      {runs.length === 0 ? (
        <p className="sidebar-empty">No runs recorded in this workspace yet.</p>
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
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
