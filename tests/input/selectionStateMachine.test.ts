import { describe, it, expect } from 'vitest'
import {
  transitionSelection,
  INITIAL_SELECTION_STATE,
  type SelectionInput,
} from '../../src/main/input/selectionStateMachine'

const maction = (action: 'click' | 'drag' | 'dblclick' | 'trplclick'): SelectionInput =>
  ({ kind: 'maction', action })
const SELECTION: SelectionInput = { kind: 'selection' }
const LONGPRESS: SelectionInput = { kind: 'longpress' }
const CONSUME: SelectionInput = { kind: 'consume' }

describe('transitionSelection', () => {
  describe('initial state', () => {
    it('starts at "none"', () => {
      expect(INITIAL_SELECTION_STATE).toBe('none')
    })

    it('selection in "none" is discarded', () => {
      const r = transitionSelection('none', SELECTION)
      expect(r.shouldStore).toBe(false)
      expect(r.state).toBe('none')
    })

    it('click in "none" stays "none" (no transition)', () => {
      const r = transitionSelection('none', maction('click'))
      expect(r.state).toBe('none')
      expect(r.shouldClear).toBe(false)
    })
  })

  describe('selection intent → pending → active', () => {
    it('drag transitions "none" → "pending" (clears to be safe)', () => {
      const r = transitionSelection('none', maction('drag'))
      expect(r.state).toBe('pending')
      expect(r.shouldStore).toBe(false)
      // Orchestrator calls clearSelection unconditionally on drag — even from
      // 'none' it's a defensive no-op, but the contract is shouldClear=true
      expect(r.shouldClear).toBe(true)
    })

    it('dblclick transitions "none" → "pending"', () => {
      const r = transitionSelection('none', maction('dblclick'))
      expect(r.state).toBe('pending')
    })

    it('trplclick transitions "none" → "pending"', () => {
      const r = transitionSelection('none', maction('trplclick'))
      expect(r.state).toBe('pending')
    })

    it('selection in "pending" → "active" + shouldStore', () => {
      const r = transitionSelection('pending', SELECTION)
      expect(r.state).toBe('active')
      expect(r.shouldStore).toBe(true)
    })

    it('selection in "active" stays "active" + shouldStore (refresh)', () => {
      const r = transitionSelection('active', SELECTION)
      expect(r.state).toBe('active')
      expect(r.shouldStore).toBe(true)
    })
  })

  describe('cancellation by single click', () => {
    it('click in "pending" → "cancelled" + shouldClear', () => {
      const r = transitionSelection('pending', maction('click'))
      expect(r.state).toBe('cancelled')
      expect(r.shouldClear).toBe(true)
    })

    it('click in "active" → "cancelled" + shouldClear', () => {
      const r = transitionSelection('active', maction('click'))
      expect(r.state).toBe('cancelled')
      expect(r.shouldClear).toBe(true)
    })

    it('click in "cancelled" stays "cancelled" + shouldClear', () => {
      const r = transitionSelection('cancelled', maction('click'))
      expect(r.state).toBe('cancelled')
      expect(r.shouldClear).toBe(true)
    })

    it('selection in "cancelled" is discarded', () => {
      const r = transitionSelection('cancelled', SELECTION)
      expect(r.shouldStore).toBe(false)
      expect(r.state).toBe('cancelled')
    })
  })

  describe('long-press reset', () => {
    it('longpress in "active" → "none" + shouldClear', () => {
      const r = transitionSelection('active', LONGPRESS)
      expect(r.state).toBe('none')
      expect(r.shouldClear).toBe(true)
    })

    it('longpress in "pending" → "none" + shouldClear', () => {
      const r = transitionSelection('pending', LONGPRESS)
      expect(r.state).toBe('none')
      expect(r.shouldClear).toBe(true)
    })

    it('longpress in "none" → "none" (no clear)', () => {
      const r = transitionSelection('none', LONGPRESS)
      expect(r.state).toBe('none')
      expect(r.shouldClear).toBe(false)
    })

    it('consume in "active" → "none" + shouldClear', () => {
      const r = transitionSelection('active', CONSUME)
      expect(r.state).toBe('none')
      expect(r.shouldClear).toBe(true)
    })
  })

  describe('realistic workflows', () => {
    it('drag → selection → consume (full select-then-command cycle)', () => {
      // 1. User drags to select
      let state = INITIAL_SELECTION_STATE
      let r = transitionSelection(state, maction('drag'))
      state = r.state
      expect(state).toBe('pending')

      // 2. Selection event arrives
      r = transitionSelection(state, SELECTION)
      state = r.state
      expect(state).toBe('active')
      expect(r.shouldStore).toBe(true)

      // 3. User triggers long-press to invoke command
      r = transitionSelection(state, LONGPRESS)
      state = r.state
      expect(state).toBe('none')
      expect(r.shouldClear).toBe(true)
    })

    it('click → false selection event → discarded (the bug we fixed)', () => {
      // 1. User single-clicks to reposition cursor
      let state = INITIAL_SELECTION_STATE
      let r = transitionSelection(state, maction('click'))
      state = r.state
      expect(state).toBe('none')  // no transition from 'none'

      // 2. selection-hook worker fires a FALSE selection event (Ctrl+C on empty selection)
      r = transitionSelection(state, SELECTION)
      expect(r.shouldStore).toBe(false)  // discarded ✓
      expect(r.state).toBe('none')
    })

    it('pending → click → false selection → discarded', () => {
      // User starts drag, then aborts by clicking elsewhere
      let state: string = 'pending'
      let r = transitionSelection(state, maction('click'))
      state = r.state
      expect(state).toBe('cancelled')

      // Stale selection event arrives after click
      r = transitionSelection(state, SELECTION)
      expect(r.shouldStore).toBe(false)
      expect(r.state).toBe('cancelled')
    })

    it('active → drag (reselect) → pending (shouldClear)', () => {
      // Refresh scenario: user already selected text, then drags to select different text
      const r = transitionSelection('active', maction('drag'))
      expect(r.state).toBe('pending')
      expect(r.shouldClear).toBe(true)  // clear old selection
    })

    it('pending → drag again → still pending (clears for fresh start)', () => {
      const r = transitionSelection('pending', maction('drag'))
      expect(r.state).toBe('pending')
      expect(r.shouldClear).toBe(true)
    })

    it('cancelled → drag → pending (recovers from cancelled state)', () => {
      const r = transitionSelection('cancelled', maction('drag'))
      expect(r.state).toBe('pending')
    })
  })

  describe('purity', () => {
    it('does not mutate input (strings are immutable anyway, but verify contract)', () => {
      const input: SelectionInput = { kind: 'maction', action: 'click' }
      const inputCopy = { ...input }
      transitionSelection('active', input)
      expect(input).toEqual(inputCopy)
    })
  })
})
