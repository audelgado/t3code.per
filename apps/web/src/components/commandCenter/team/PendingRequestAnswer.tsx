import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import { derivePendingApprovals, derivePendingUserInputs } from "~/session-logic";
import { useThreadProjection } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { ComposerPendingApprovalActions } from "../../chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../../chat/ComposerPendingApprovalPanel";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

/**
 * Answers the oldest approval or question of an agent's thread in place, through the same
 * runtime-request response commands as the chat composer. Mount it only while the user has the
 * row open: it subscribes to that one thread's detail.
 */
export function PendingRequestAnswer({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const thread = useThreadProjection(ref);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const respondToApproval = useOrchestrationCommand(
    threadEnvironment.respondToApproval,
    "answer approval",
  );
  const [responding, setResponding] = useState(false);
  const requests = useMemo(
    () => (thread === null ? null : derivePendingThreadRequests(thread.projection)),
    [thread],
  );

  if (requests === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const approval = derivePendingApprovals(requests.approvals)[0];
  const userInput = derivePendingUserInputs(requests.userInputs)[0];

  if (approval) {
    const onRespond = async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      setResponding(true);
      const result = await respondToApproval({
        environmentId,
        input: { threadId, requestId, decision },
      });
      setResponding(false);
      return result;
    };
    return (
      <div className="flex flex-col gap-2 rounded-lg border bg-background p-2">
        <ComposerPendingApprovalPanel
          approval={approval}
          pendingCount={requests.approvals.length}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <ComposerPendingApprovalActions
            requestId={approval.requestId}
            isResponding={responding}
            canRespond={canOperate && approval.responseCapability === "live"}
            options={approval.options}
            onRespondToApproval={onRespond}
          />
        </div>
      </div>
    );
  }
  if (userInput) {
    return (
      <UserInputAnswer
        key={userInput.requestId}
        environmentId={environmentId}
        threadId={threadId}
        request={userInput}
        canOperate={canOperate}
      />
    );
  }
  return <p className="text-xs text-muted-foreground">Nothing is waiting anymore.</p>;
}

function UserInputAnswer({
  environmentId,
  threadId,
  request,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: ThreadPendingUserInput;
  readonly canOperate: boolean;
}) {
  const respond = useOrchestrationCommand(threadEnvironment.respondToUserInput, "answer question");
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, "dismiss question");
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>(() =>
    seedUserInputDraftAnswers(request.questions, {}),
  );
  const [busy, setBusy] = useState(false);
  const answers = buildPendingUserInputAnswers(request.questions, drafts);
  const live = request.responseCapability !== "not_resumable";
  const disabled = busy || !canOperate || !live;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border bg-background p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (answers === null || disabled) return;
        void run(() =>
          respond({
            environmentId,
            input: { threadId, requestId: request.requestId, answers },
          }),
        );
      }}
    >
      {request.questions.map((question) => {
        const draft = drafts[question.id];
        const selected = draft?.selectedOptionValues ?? [];
        return (
          <fieldset key={question.id} disabled={disabled} className="flex flex-col gap-1.5">
            <legend className="text-xs text-muted-foreground">{question.header}</legend>
            <p className="text-sm">{question.question}</p>
            {question.options.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const value = option.value ?? option.label;
                  return (
                    <Button
                      key={value}
                      type="button"
                      size="xs"
                      variant={selected.includes(value) ? "default" : "outline"}
                      title={option.description}
                      aria-pressed={selected.includes(value)}
                      onClick={() =>
                        setDrafts((current) => ({
                          ...current,
                          [question.id]: togglePendingUserInputOptionSelection(
                            question,
                            current[question.id],
                            value,
                          ),
                        }))
                      }
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            {question.allowCustomAnswer === false ? null : (
              <Input
                size="sm"
                aria-label={question.question}
                placeholder={question.options.length > 0 ? "Or type an answer" : "Your answer"}
                value={draft?.customAnswer ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [question.id]: setPendingUserInputCustomAnswer(
                      current[question.id],
                      event.target.value,
                      question,
                    ),
                  }))
                }
              />
            )}
          </fieldset>
        );
      })}
      {live ? null : (
        <p className="text-xs text-muted-foreground">
          The provider process is gone. Open the thread to restart the run.
        </p>
      )}
      <div className="flex justify-end gap-2">
        {request.dismissible ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy || !canOperate}
            onClick={() =>
              void run(() =>
                dismiss({ environmentId, input: { threadId, requestId: request.requestId } }),
              )
            }
          >
            Dismiss
          </Button>
        ) : null}
        <Button type="submit" size="xs" disabled={disabled || answers === null}>
          Send answer
        </Button>
      </div>
    </form>
  );
}
