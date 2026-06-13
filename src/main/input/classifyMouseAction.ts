/**
 * Pure mouse-action classifier — extracted from MouseMonitor for testability.
 *
 * The MouseMonitor class is hard to unit-test because its lifecycle is tied to
 * koffi (Win32 user32.dll). This module contains the pure classification logic
 * (drag vs click vs dblclick vs trplclick) with no side effects, so it can be
 * exercised directly by Vitest without any native dependencies.
 *
 * Classification rules:
 * 1. If distance between mouseDown and mouseUp >= clickDragThresholdPx → 'drag'
 * 2. Otherwise, the click joins the current multi-click sequence iff:
 *      - previous click exists (clickCount > 0)
 *      - time since previous click < doubleClickTime
 *      - distance from previous click < multiClickMaxDistance
 * 3. Sequence count: 1=click, 2=dblclick, 3=trplclick. Resets after 3.
 */

export type MouseActionType = 'click' | 'drag' | 'dblclick' | 'trplclick'

export interface MouseActionEvent {
  type: MouseActionType
  x: number
  y: number
  timestamp: number
}

export interface ClickClassifierState {
  /** Consecutive click count in current sequence (0 = no prior click) */
  clickCount: number
  /** Timestamp of the previous click's mouseUp (ms since epoch) */
  lastClickTime: number
  /** Position of the previous click's mouseUp */
  lastClickPos: { x: number; y: number }
}

export interface ClickClassifierConfig {
  /** Windows double-click time window (ms), from GetDoubleClickTime() */
  doubleClickTime: number
  /** Max distance between consecutive clicks to count as multi-click (px) */
  multiClickMaxDistance: number
  /** Movement threshold between down and up to classify as drag (px) */
  clickDragThresholdPx: number
}

export interface MouseUpInput {
  /** Cursor position at mouse-down */
  downX: number
  downY: number
  /** Cursor position at mouse-up */
  upX: number
  upY: number
  /** Timestamp of mouse-up (ms since epoch) */
  timestamp: number
}

export interface ClassifyResult {
  action: MouseActionEvent
  newState: ClickClassifierState
}

/** Default classifier state — no prior clicks */
export const INITIAL_STATE: ClickClassifierState = {
  clickCount: 0,
  lastClickTime: 0,
  lastClickPos: { x: 0, y: 0 },
}

/**
 * Classify a mouse-up event and produce the next classifier state.
 *
 * Pure function — given the same inputs, always returns the same outputs.
 * No side effects, no I/O, no native deps.
 */
export function classifyMouseAction(
  input: MouseUpInput,
  state: ClickClassifierState,
  config: ClickClassifierConfig,
): ClassifyResult {
  const { downX, downY, upX, upY, timestamp } = input

  // ─── Drag: significant movement between down and up ───
  const downDx = upX - downX
  const downDy = upY - downY
  const downDistance = Math.sqrt(downDx * downDx + downDy * downDy)

  if (downDistance >= config.clickDragThresholdPx) {
    // Drag breaks any pending multi-click sequence
    return {
      action: { type: 'drag', x: upX, y: upY, timestamp },
      newState: { clickCount: 0, lastClickTime: 0, lastClickPos: { x: 0, y: 0 } },
    }
  }

  // ─── Click: classify as single / double / triple ───
  const timeSinceLastClick = timestamp - state.lastClickTime
  const lastDx = upX - state.lastClickPos.x
  const lastDy = upY - state.lastClickPos.y
  const lastDistance = Math.sqrt(lastDx * lastDx + lastDy * lastDy)

  let clickCount: number
  if (
    state.clickCount > 0 &&
    timeSinceLastClick < config.doubleClickTime &&
    lastDistance < config.multiClickMaxDistance
  ) {
    clickCount = state.clickCount + 1
  } else {
    clickCount = 1
  }

  const type: MouseActionType =
    clickCount === 1 ? 'click' :
    clickCount === 2 ? 'dblclick' :
    'trplclick'

  // Reset after triple-click — Windows doesn't define quadruple-click
  const nextCount = clickCount >= 3 ? 0 : clickCount

  return {
    action: { type, x: upX, y: upY, timestamp },
    newState: {
      clickCount: nextCount,
      lastClickTime: timestamp,
      lastClickPos: { x: upX, y: upY },
    },
  }
}
