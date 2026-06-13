/**
 * Selection routing state machine — extracted from Orchestrator for testability.
 *
 * Problem being solved:
 *   The selection-hook worker fires FALSE selection events on single clicks
 *   (its Clipboard fallback sends Ctrl+C on any click-like gesture). These
 *   stale events caused wrong routing (dictation text overwriting selected
 *   text, or agent mode triggering without real selection).
 *
 * Solution:
 *   Track mouse actions independently. Only consider a selection "real" if it
 *   arrives after a selection-intent gesture (drag/dblclick/trplclick). A
 *   single click (cursor reposition) cancels any pending selection and causes
 *   subsequent selection events to be discarded until the next intent gesture.
 *
 * This module is the pure transition function — no I/O, no side effects.
 */

import type { MouseActionType } from './classifyMouseAction'

export type SelectionState = 'none' | 'pending' | 'active' | 'cancelled'

export type SelectionInput =
  | { kind: 'maction'; action: MouseActionType }
  | { kind: 'selection' }
  | { kind: 'longpress' }     // long-press consumed the gesture — reset
  | { kind: 'consume' }       // selection was consumed by long-press trigger

export interface SelectionTransition {
  state: SelectionState
  /** True if this selection event represents a real selection to store */
  shouldStore: boolean
  /** True if any previously-stored selection should be cleared (state reset) */
  shouldClear: boolean
}

export const INITIAL_SELECTION_STATE: SelectionState = 'none'

/**
 * Compute the next state given an input event.
 *
 * Pure function — same inputs always produce the same outputs.
 *
 * Storage rules:
 *   - 'shouldStore=true' ONLY when a selection arrives in 'pending' or 'active'
 *   - 'shouldClear=true' when transitioning out of an active/pending state
 *     due to a non-selection action (click, drag, dblclick, trplclick, longpress)
 *
 * The caller is responsible for actually storing/clearing selection data.
 * This function only decides what *should* happen.
 */
export function transitionSelection(
  prev: SelectionState,
  input: SelectionInput,
): SelectionTransition {
  switch (input.kind) {
    case 'maction': {
      if (input.action === 'click') {
        // Single click = cursor reposition. Cancel any active selection.
        if (prev === 'none') {
          return { state: 'none', shouldStore: false, shouldClear: false }
        }
        // Transition to 'cancelled' — clear stored selection
        return { state: 'cancelled', shouldStore: false, shouldClear: true }
      }
      // drag / dblclick / trplclick = user is selecting text.
      // Always reset to pending and clear any prior selection (matches
      // Orchestrator behavior: clearSelection() is called unconditionally
      // on selection-intent gestures, even from 'pending' or 'none').
      return { state: 'pending', shouldStore: false, shouldClear: true }
    }

    case 'selection': {
      if (prev === 'pending') {
        // Genuine selection following a selection-intent gesture
        return { state: 'active', shouldStore: true, shouldClear: false }
      }
      if (prev === 'active') {
        // Refresh — user selected different text while still active
        return { state: 'active', shouldStore: true, shouldClear: false }
      }
      // 'none' or 'cancelled' → discard (false positive from worker)
      return { state: prev, shouldStore: false, shouldClear: false }
    }

    case 'longpress':
    case 'consume': {
      // Long-press fired — reset everything
      if (prev === 'none') {
        return { state: 'none', shouldStore: false, shouldClear: false }
      }
      return { state: 'none', shouldStore: false, shouldClear: true }
    }
  }
}
