import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  useAutoReview,
  type AutoReviewPhase,
  type ReviewMeta,
} from '../contexts/AutoReviewContext';
import { computePlanDiff } from '../utils/planDiffEngine';
import { requestNotificationPermission, notify } from '../utils/notifications';
import { addCost, getTodayCost, getCostOverDays, formatCost, RED_TEAM_COST_ESTIMATE } from '../utils/costTracker';

// Re-export ReviewMeta so existing callers (`@plannotator/ui/components/AutoReviewCountdown`)
// keep working without touching their imports.
export type { ReviewMeta } from '../contexts/AutoReviewContext';

interface AutoReviewCountdownProps {
  plan: string;
  onPlanRevised: (newPlan: string, versionInfo: any) => void;
  onAutoApprove: () => void;
  onAnnotationsCleared?: () => void;
  /** @deprecated — meta now lives in AutoReviewContext. Kept for backwards compatibility. */
  onReviewComplete?: (meta: ReviewMeta) => void;
  hasAnnotations: boolean;
  disabled?: boolean;
  countdownSeconds?: number;
  /** Seconds for the post-deliberation approval countdown (default: 10). */
  approvalCountdownSeconds?: number;
  /** When true, a multi-LLM review already completed (e.g. via shell) — skip deliberation and jump to approval countdown. */
  reviewAlreadyDone?: boolean;
}

// OpenRouter pricing (USD per 1M tokens). Keep in sync with server/apply-review.
const PRICING: Record<string, { input: number; output: number }> = {
  'google/gemini-3-flash-preview': { input: 0.05, output: 0.15 },
  'openai/gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'x-ai/grok-4.1-fast': { input: 0.15, output: 0.60 },
  'deepseek/deepseek-chat-v3-0324': { input: 0.14, output: 0.28 },
  'mistralai/mistral-small-3.1-24b-instruct': { input: 0.10, output: 0.30 },
};

// Short names from council.py → human-readable labels for the console.
const MODEL_SHORT_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  gpt: 'GPT-4.1 Mini',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
};

const STAGE_LABELS: Record<string, string> = {
  diverge: 'Diverge',
  rank: 'Rank',
  synthesize: 'Synthesize',
};

/** Convert a council.py structured event into a human-readable log line. */
function councilEventToLog(evt: any): string | null {
  switch (evt.event) {
    case 'stage_start': {
      const stage = STAGE_LABELS[evt.stage] || evt.stage;
      const models = (evt.models as string[] | undefined)
        ?.map((m: string) => MODEL_SHORT_NAMES[m] || m)
        .join(', ');
      return models
        ? `Stage: ${stage} (${models})`
        : `Stage: ${stage}`;
    }
    case 'model_done': {
      const name = MODEL_SHORT_NAMES[evt.model] || evt.model;
      return evt.status === 'success'
        ? `✓ ${name} done`
        : `❌ ${name} failed`;
    }
    case 'stage_done': {
      const stage = STAGE_LABELS[evt.stage] || evt.stage;
      const dur = evt.duration_ms
        ? ` (${(evt.duration_ms / 1000).toFixed(1)}s)`
        : '';
      return `✓ ${stage} complete${dur}`;
    }
    default:
      return null;
  }
}

function estimateCost(structured: any): ReviewMeta | null {
  if (!structured?.models) return null;
  let totalCost = 0;
  for (const m of structured.models) {
    const p = PRICING[m.modelId] || { input: 0.20, output: 0.60 };
    totalCost += (m.inputTokens * p.input + m.outputTokens * p.output) / 1_000_000;
  }
  if (structured.synthesizer) {
    const p = PRICING[structured.synthesizer.modelId] || { input: 0.20, output: 0.60 };
    totalCost +=
      (structured.synthesizer.inputTokens * p.input +
        structured.synthesizer.outputTokens * p.output) /
      1_000_000;
  }
  return {
    models: structured.models,
    synthesizer: structured.synthesizer,
    totalDurationMs: structured.totalDurationMs || 0,
    estimatedCost: totalCost,
  };
}

export const AutoReviewCountdown: React.FC<AutoReviewCountdownProps> = ({
  plan,
  onPlanRevised,
  onAutoApprove,
  onAnnotationsCleared,
  onReviewComplete,
  hasAnnotations,
  disabled = false,
  countdownSeconds = 8,
  approvalCountdownSeconds = 10,
  reviewAlreadyDone = false,
}) => {
  const { phase, secondsLeft, errorMsg, isDrawerOpen, actions } = useAutoReview();
  const [todayCost, setTodayCost] = useState<number>(() => getTodayCost());

  // Refs kept local — they're non-render state tied to the fetch lifecycle.
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consensusRef = useRef<string>('');
  const structuredRef = useRef<any>(null);
  const planRef = useRef(plan);
  // Snapshot of the plan at the moment deliberation started, used as the
  // "old" side of the diff stats after /api/apply-review returns a new plan.
  const planBeforeApplyRef = useRef<string>('');

  // Keep planRef in sync with the latest plan prop.
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  // Request notification permission early so later notifications work.
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Auto-start the countdown on mount (unless disabled).
  // If a multi-LLM review already ran (e.g. via shell), skip straight to
  // the approval countdown — no need to deliberate again.
  useEffect(() => {
    if (!disabled) {
      if (reviewAlreadyDone) {
        actions.appendLogRaw('Multi-LLM review already completed — approving.');
        actions.openDrawer();
        notify('Plannotator', 'Multi-LLM review complete — auto-approving.');
        onAutoApprove();
        actions.setPhase('done');
      } else {
        actions.beginCountdown('countdown', countdownSeconds);
      }
    }
    // Intentionally run once on mount — the pill lives for the session and
    // doesn't restart if the parent re-renders with new props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause the pre-deliberation countdown if the user adds annotations.
  useEffect(() => {
    if (hasAnnotations && phase === 'countdown') {
      actions.setPhase('paused');
    }
  }, [hasAnnotations, phase, actions]);

  // Tick loop — only runs while a countdown phase is active.
  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'approval_countdown') {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setInterval(() => {
      actions.tick();
    }, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [phase, actions]);

  // Transition effect — fires when a countdown hits 0.
  useEffect(() => {
    if (secondsLeft > 0) return;
    if (phase === 'countdown') {
      startDeliberation();
    } else if (phase === 'approval_countdown') {
      // Call onAutoApprove BEFORE setting phase to 'done'. handleApprove is
      // async so it starts the fetch immediately; setPhase('done') then
      // unmounts this component on the next render, but the promise
      // continues independently. Calling approve first ensures the fetch
      // is initiated before any unmount risk.
      notify('Plannotator', 'Plan auto-approved — Claude Code will continue.');
      onAutoApprove();
      actions.setPhase('done');
    }
    // Only react to the 0-crossing; deps intentionally narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, phase]);

  // Auto-collapse the drawer 2s after the flow completes so the user sees the
  // summary, then the UI gets out of the way. The pill itself unmounts on 'done'.
  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(() => {
      actions.closeDrawer();
    }, 2000);
    return () => clearTimeout(t);
  }, [phase, actions]);

  const startDeliberation = useCallback(async () => {
    // Reset per-run state so a second review doesn't inherit logs/consensus
    // from the first.
    actions.resetForNewRun();
    actions.openDrawer();
    actions.setPhase('deliberating');
    actions.appendLogRaw('Starting multi-LLM review...');
    notify('Plannotator', 'Multi-LLM review started — models are deliberating.');
    consensusRef.current = '';
    structuredRef.current = null;
    planBeforeApplyRef.current = planRef.current;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/multi-llm-review-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planRef.current }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (res.status === 409) {
          // council.py already running (e.g. triggered via shell) — silently stop
          actions.appendLog({ ts: Date.now(), level: 'info', text: 'Skipped — review already running in shell' });
          actions.setPhase('idle');
          actions.closeDrawer();
          return;
        }
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.event === 'log') {
              actions.appendLogRaw(evt.message || '');
            } else if (evt.event === 'error') {
              throw new Error(evt.message || 'Deliberation failed');
            } else if (evt.event === 'result') {
              consensusRef.current =
                typeof evt.result === 'string'
                  ? evt.result
                  : JSON.stringify(evt.structured || evt.result);
              if (evt.structured) structuredRef.current = evt.structured;
              actions.setConsensus(consensusRef.current);
            } else {
              // Council.py structured events (stage_start, model_done, stage_done)
              const logMsg = councilEventToLog(evt);
              if (logMsg) actions.appendLogRaw(logMsg);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue; // Skip malformed SSE
            throw e;
          }
        }
      }

      if (!consensusRef.current) {
        throw new Error('No result received from deliberation');
      }

      await applyFeedback(consensusRef.current);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      const msg = err?.message || 'Unknown error';
      // Surface actionable detail for network errors
      const detail =
        err?.name === 'TypeError' && msg === 'Failed to fetch'
          ? 'Failed to fetch — server may have restarted. Try refreshing the page.'
          : msg;
      console.error('[plannotator] multi-LLM review error:', err);
      actions.setError(detail);
      actions.appendLog({ ts: Date.now(), level: 'error', text: detail });
      actions.setPhase('error');
      notify('Plannotator — Error', detail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFeedback = useCallback(
    async (feedback: string) => {
      actions.setPhase('applying');
      actions.appendLog({
        ts: Date.now(),
        level: 'system',
        text: 'Applying consensus feedback to plan...',
      });

      try {
        const res = await fetch('/api/apply-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: planRef.current, feedback }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(err.error || `Failed to apply review`);
        }

        const data = await res.json();

        // Compute diff stats BEFORE handing the new plan back to the parent,
        // because once setMarkdown fires, planRef.current will update and we
        // lose the original. planBeforeApplyRef captured the pre-deliberation
        // version at startDeliberation() time.
        const oldPlan = planBeforeApplyRef.current;
        const newPlan: string = data.plan;
        try {
          const { stats } = computePlanDiff(oldPlan, newPlan);
          actions.setDiffStats({
            additions: stats.additions,
            deletions: stats.deletions,
          });
        } catch {
          // Diff failure is non-fatal — drawer just hides the Changes section.
        }

        onPlanRevised(newPlan, data.versionInfo);
        onAnnotationsCleared?.();

        const meta = estimateCost(structuredRef.current);
        if (meta) {
          actions.setMeta(meta);
          onReviewComplete?.(meta);
          addCost(meta.estimatedCost);
          setTodayCost(getTodayCost());
        }

        actions.appendLog({
          ts: Date.now(),
          level: 'ok',
          text: 'Plan updated. Auto-approving…',
        });

        notify('Plannotator', 'Plan revised by consensus — auto-approving.');

        // Fire-and-forget streaming adversarial review against the freshly-applied
        // plan. Must NEVER delay onAutoApprove — chunks stream into the drawer
        // as the model produces them.
        actions.setRedTeamLoading(true);
        actions.setRedTeamFindings('');
        (async () => {
          try {
            const res = await fetch('/api/red-team-review-stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ plan: data.plan, consensus: feedback }),
            });
            if (!res.ok || !res.body) {
              throw new Error(`HTTP ${res.status}`);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let accumulated = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const evt = JSON.parse(line.slice(6));
                  if (evt.event === 'chunk') {
                    accumulated += evt.text;
                    actions.setRedTeamFindings(accumulated);
                  } else if (evt.event === 'done') {
                    actions.setRedTeamLoading(false);
                    addCost(RED_TEAM_COST_ESTIMATE);
                    setTodayCost(getTodayCost());
                    actions.appendLog({
                      ts: Date.now(),
                      level: 'info',
                      text: `Adversarial review complete (${evt.modelId}, ${(evt.durationMs / 1000).toFixed(1)}s)`,
                    });
                  } else if (evt.event === 'error') {
                    throw new Error(evt.message || 'Stream error');
                  }
                } catch (e) {
                  if (e instanceof SyntaxError) continue;
                  throw e;
                }
              }
            }
            actions.setRedTeamLoading(false);
          } catch (err: any) {
            console.error('[red-team] failed:', err);
            actions.setRedTeamError(err?.message || 'Failed');
            actions.setRedTeamLoading(false);
          }
        })();

        // Policy gate: check if approval is allowed before auto-approving.
        // A blocking policy converts auto-approve into a manual hold — the
        // plan stays in review until the user clicks Approve in the main UI.
        let policyAllows = true;
        try {
          const polRes = await fetch('/api/policies/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan: data.plan }),
          });
          if (polRes.ok) {
            const decision = await polRes.json();
            if (!decision.auto_approve) {
              policyAllows = false;
              const reasons = (decision.blocked_by || [])
                .map((b: any) => `${b.pattern} → "${b.evidence}"`)
                .join('; ');
              actions.appendLog({
                ts: Date.now(),
                level: 'info',
                text: `Auto-approve held by policy: ${reasons || 'matched a block pattern'}`,
              });
              actions.openDrawer();
              notify('Plannotator', 'Auto-approve held — policy requires human review.');
            }
          }
        } catch (err) {
          console.error('[policies] evaluate failed:', err);
          // On failure, default to auto-approving (fail-open) — policies are an
          // additive guardrail, not a hard gate. User can still deny.
        }

        if (policyAllows) {
          // Hand off to approval_countdown — the tick loop fires onAutoApprove
          // when it hits 0. Decoupling from this promise chain ensures
          // auto-approve isn't lost if the parent re-renders mid-flow, and
          // gives React time to flush the setMarkdown(newPlan) from
          // onPlanRevised before /api/approve reads it.
          actions.beginCountdown('approval_countdown', approvalCountdownSeconds);
        } else {
          // Stay in 'applying' phase visually; user must approve manually.
          actions.setPhase('idle');
        }
      } catch (err: any) {
        const msg = err?.message || 'Failed to apply feedback';
        actions.setError(msg);
        actions.appendLog({ ts: Date.now(), level: 'error', text: msg });
        actions.setPhase('error');
        notify('Plannotator — Error', msg);
      }
    },
    // `actions` is stable (memoized inside the provider) so omitting it is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [countdownSeconds, approvalCountdownSeconds, onPlanRevised, onAnnotationsCleared, onReviewComplete],
  );

  const handlePause = () => {
    if (phase === 'countdown') actions.setPhase('paused');
    else if (phase === 'approval_countdown') actions.setPhase('approval_paused');
  };

  const handleResume = () => {
    if (phase === 'paused') actions.setPhase('countdown');
    else if (phase === 'approval_paused') actions.setPhase('approval_countdown');
  };

  const handleRunNow = () => {
    if (phase === 'countdown' || phase === 'paused') {
      startDeliberation();
    }
  };

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    actions.setPhase('idle');
    actions.closeDrawer();
  };

  const handleRetry = () => {
    startDeliberation();
  };

  if (phase === 'idle' || phase === 'done' || disabled) return null;

  const progress =
    phase === 'countdown' || phase === 'approval_countdown'
      ? secondsLeft / countdownSeconds
      : 0;
  const circumference = 2 * Math.PI * 8;
  const dashOffset = circumference * (1 - progress);

  // The drawer chevron is visible during and after deliberation so users can
  // reopen the console to re-inspect logs/consensus after dismissing it.
  const showChevron =
    phase === 'deliberating' ||
    phase === 'applying' ||
    phase === 'approval_countdown' ||
    phase === 'approval_paused' ||
    phase === 'error';

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-primary/10 border border-primary/20 text-primary select-none">
      {/* Countdown phases */}
      {(phase === 'countdown' || phase === 'approval_countdown') && (
        <>
          <svg className="w-5 h-5 -rotate-90 shrink-0" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
            <circle
              cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2"
              strokeDasharray={circumference} strokeDashoffset={dashOffset}
              strokeLinecap="round"
              className="transition-[stroke-dashoffset] duration-1000 ease-linear"
            />
          </svg>
          <span
            className="whitespace-nowrap"
            title={
              phase === 'countdown'
                ? 'Will run multi-LLM review: 4 models deliberate on your plan, then auto-revise it'
                : 'Will auto-approve the revised plan'
            }
          >
            {phase === 'countdown'
              ? `Multi-LLM review in ${secondsLeft}s`
              : `Auto-approve in ${secondsLeft}s`}
          </span>
          <button onClick={handlePause} className="p-0.5 rounded hover:bg-primary/20" title="Pause countdown">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
              <rect x="4" y="3" width="3" height="10" rx="0.5" />
              <rect x="9" y="3" width="3" height="10" rx="0.5" />
            </svg>
          </button>
          {phase === 'countdown' && (
            <button onClick={handleRunNow} className="p-0.5 rounded hover:bg-primary/20" title="Run multi-LLM review now">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                <path d="M5 3l8 5-8 5V3z" />
              </svg>
            </button>
          )}
          <button onClick={handleStop} className="p-0.5 rounded hover:bg-muted text-muted-foreground" title="Cancel — stop auto-review">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}

      {/* Paused */}
      {(phase === 'paused' || phase === 'approval_paused') && (
        <>
          <span className="text-muted-foreground whitespace-nowrap">
            {phase === 'paused' ? 'Multi-LLM review paused' : 'Auto-approve paused'}
          </span>
          <button onClick={handleResume} className="p-0.5 rounded hover:bg-primary/20" title="Resume countdown">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
              <path d="M5 3l8 5-8 5V3z" />
            </svg>
          </button>
          {phase === 'paused' && (
            <button onClick={handleRunNow} className="p-0.5 rounded hover:bg-primary/20 text-[10px]" title="Run multi-LLM review now">
              Now
            </button>
          )}
          <button onClick={handleStop} className="p-0.5 rounded hover:bg-muted text-muted-foreground" title="Cancel — stop auto-review">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}

      {/* Deliberating — concise phase label; log detail lives in the drawer */}
      {phase === 'deliberating' && (
        <>
          <svg className="w-4 h-4 animate-spin shrink-0" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="whitespace-nowrap">Deliberating…</span>
          <button
            onClick={handleStop}
            className="p-0.5 rounded hover:bg-destructive/20 text-destructive"
            title="Stop"
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        </>
      )}

      {/* Applying */}
      {phase === 'applying' && (
        <>
          <svg className="w-4 h-4 animate-spin shrink-0" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="whitespace-nowrap">Applying…</span>
        </>
      )}

      {/* Error */}
      {phase === 'error' && (
        <>
          <span className="text-destructive whitespace-nowrap max-w-[180px] truncate" title={errorMsg}>
            Review failed
          </span>
          <button onClick={handleRetry} className="p-0.5 rounded hover:bg-primary/20" title="Retry">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2">
              <path d="M2 8a6 6 0 0111.5-2.5M14 8a6 6 0 01-11.5 2.5" strokeLinecap="round" />
              <path d="M14 2v4h-4M2 14v-4h4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={handleStop} className="p-0.5 rounded hover:bg-muted text-muted-foreground" title="Dismiss">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}

      {/* Daily LLM spend — informational, always visible alongside the pill content */}
      {todayCost > 0 && (
        <span
          className="text-[10px] text-primary/70 tabular-nums whitespace-nowrap pl-1 border-l border-primary/20 ml-1"
          title={`LLM spend today: ${formatCost(todayCost)} · last 7 days: ${formatCost(getCostOverDays(7))}`}
        >
          {formatCost(todayCost)}
        </span>
      )}

      {/* Drawer chevron — shown whenever the console has content to reveal */}
      {showChevron && (
        <button
          onClick={() => actions.toggleDrawer()}
          className="p-0.5 rounded hover:bg-primary/20 shrink-0"
          title={isDrawerOpen ? 'Hide multi-LLM console' : 'Show multi-LLM console'}
        >
          <svg
            className={`w-3 h-3 transition-transform ${isDrawerOpen ? '' : 'rotate-180'}`}
            fill="none"
            viewBox="0 0 16 16"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
};
