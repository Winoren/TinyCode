/**
 * The event timeline. Every row is keyed and memoized; long lists opt rows out
 * of off-screen render work with `content-visibility`.
 */

import { memo } from "react";
import type { AgentEvent } from "tinycode/dist/core/contracts.js";
import {
  excerpt,
  formatDuration,
  type AssistantItem,
  type HumanItem,
  type NoteItem,
  type TerminalItem,
  type TimelineItem,
  type ToolItem,
  type UsageItem,
} from "../timeline.ts";

export const Timeline = memo(function Timeline({
  items,
  emptyHint,
}: {
  items: readonly TimelineItem[];
  emptyHint: string;
}) {
  if (items.length === 0) {
    return <p className="timeline-empty">{emptyHint}</p>;
  }
  return (
    <ol className="timeline" aria-label="Run timeline">
      {items.map((item) => (
        <Row key={item.key} item={item} />
      ))}
    </ol>
  );
});

const Row = memo(function Row({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "tool":
      return <ToolRow item={item} />;
    case "assistant":
      return <AssistantRow item={item} />;
    case "human":
      return <HumanRow item={item} />;
    case "note":
      return <NoteRow item={item} />;
    case "usage":
      return <UsageRow item={item} />;
    case "terminal":
      return <TerminalRow item={item} />;
  }
});

const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const stateLabel =
    item.status === "running"
      ? "运行中"
      : item.status === "success"
        ? "成功"
        : item.status === "declined"
          ? "已拒绝"
          : "错误";
  return (
    <li className={`row tool status-${item.status}`} data-testid="timeline-tool" data-status={item.status}>
      <span className="sequence">{item.sequence}</span>
      <div className="row-body">
        <div className="tool-head">
          <span className="tool-name">{item.toolName}</span>
          <span className={`chip chip-${item.status}`}>{stateLabel}</span>
          {item.durationMs !== undefined && item.status !== "running" && (
            <span className="tool-duration">{formatDuration(item.durationMs)}</span>
          )}
        </div>
        {item.args !== undefined && <pre className="tool-args">{excerpt(item.args)}</pre>}
        {item.error !== undefined && (
          <p className="tool-error">
            {item.error.code}: {item.error.message}
          </p>
        )}
        {item.status === "success" && item.result !== undefined && (
          <pre className="tool-result">{excerpt(item.result)}</pre>
        )}
      </div>
    </li>
  );
});

const AssistantRow = memo(function AssistantRow({ item }: { item: AssistantItem }) {
  return (
    <li className="row assistant" data-testid="timeline-assistant">
      <span className="sequence">{item.sequence}</span>
      <div className="row-body">
        {item.thinking !== "" && (
          <details className="thinking">
            <summary>思考过程</summary>
            <div className="thinking-text">{item.thinking}</div>
          </details>
        )}
        <div className="assistant-text">{item.text}</div>
      </div>
    </li>
  );
});

const HumanRow = memo(function HumanRow({ item }: { item: HumanItem }) {
  return (
    <li className="row human" data-testid="timeline-human">
      <span className="sequence">{item.sequence}</span>
      <div className="row-body">
        <p className="human-question">{item.question}</p>
        {item.answer !== undefined && (
          <p className="human-answer">已回答：{excerpt(item.answer, 120)}</p>
        )}
      </div>
    </li>
  );
});

const NoteRow = memo(function NoteRow({ item }: { item: NoteItem }) {
  return (
    <li className={`row note tone-${item.tone}`} data-testid="timeline-note">
      <span className="sequence">{item.sequence}</span>
      <div className="row-body">{item.text}</div>
    </li>
  );
});

const UsageRow = memo(function UsageRow({ item }: { item: UsageItem }) {
  const usage = item.usage;
  return (
    <li className="usage" data-testid="usage-panel">
      <dl className="usage-list">
        {usage.model !== undefined && (
          <div className="usage-cell">
            <dt>模型</dt>
            <dd>{usage.model}</dd>
          </div>
        )}
        {usage.inputTokens !== undefined && (
          <div className="usage-cell">
            <dt>输入</dt>
            <dd>{usage.inputTokens.toLocaleString()} tok</dd>
          </div>
        )}
        {usage.outputTokens !== undefined && (
          <div className="usage-cell">
            <dt>输出</dt>
            <dd>{usage.outputTokens.toLocaleString()} tok</dd>
          </div>
        )}
        {usage.costUSD !== undefined && (
          <div className="usage-cell">
            <dt>费用</dt>
            <dd>${usage.costUSD.toFixed(4)}</dd>
          </div>
        )}
        <div className="usage-cell">
          <dt>工具调用</dt>
          <dd>{usage.toolCalls}</dd>
        </div>
        <div className="usage-cell">
          <dt>耗时</dt>
          <dd>{formatDuration(usage.durationMs)}</dd>
        </div>
      </dl>
    </li>
  );
});

const TerminalRow = memo(function TerminalRow({ item }: { item: TerminalItem }) {
  const event: AgentEvent = item.event;
  if (event.type === "run_completed") {
    return (
      <li className="terminal terminal-complete" data-testid="terminal-banner" data-terminal-status={event.status}>
        {event.status === "complete" ? (
          <p>运行完成。</p>
        ) : (
          <p>
            运行部分完成——缺失材料：{(event.missingMaterial ?? []).join("、")}
          </p>
        )}
        <p className="terminal-detail">{event.result}</p>
      </li>
    );
  }
  if (event.type === "run_failed") {
    return (
      <li className="terminal terminal-failed" data-testid="terminal-banner" data-terminal-status="failed">
        <p>
          运行失败——{event.error.code}
        </p>
        <p className="terminal-detail">{event.error.message}</p>
      </li>
    );
  }
  return (
    <li className="terminal terminal-cancelled" data-testid="terminal-banner" data-terminal-status="cancelled">
      <p>运行已取消。</p>
    </li>
  );
});
