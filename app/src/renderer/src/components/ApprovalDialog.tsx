/**
 * The approval dialog. Rendered while a human-input request is pending.
 *
 * The Approve/Decline buttons cover gate confirmations; the free-text field
 * covers `ask_human` questions where the model wants an actual answer. Anything
 * not recognisably affirmative counts as a refusal, per the Core's own rule.
 */

import { useState } from "react";

export interface PendingRequest {
  requestId: number;
  question: string;
}

export function ApprovalDialog({
  request,
  onAnswer,
}: {
  request: PendingRequest;
  onAnswer: (value: unknown) => void;
}) {
  const [text, setText] = useState("");

  const submitText = (): void => {
    const trimmed = text.trim();
    if (trimmed !== "") onAnswer(trimmed);
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-question"
        data-testid="approval-dialog"
      >
        <h2 id="approval-question">Approval needed</h2>
        <pre className="dialog-question" data-testid="approval-question">
          {request.question}
        </pre>
        <input
          className="dialog-input"
          type="text"
          placeholder="Or type an answer for the agent…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitText();
          }}
        />
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-danger"
            data-testid="decline-button"
            onClick={() => onAnswer("no")}
          >
            Decline
          </button>
          <button
            type="button"
            className="button button-primary"
            data-testid="approve-button"
            onClick={() => onAnswer("approve")}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
