import { describe, it, expect } from 'vitest'
import {
  classifyMouseAction,
  INITIAL_STATE,
  type ClickClassifierConfig,
} from '../../src/main/input/classifyMouseAction'

const DEFAULT_CONFIG: ClickClassifierConfig = {
  doubleClickTime: 500,
  multiClickMaxDistance: 4,
  clickDragThresholdPx: 8,
}

describe('classifyMouseAction', () => {
  describe('single click', () => {
    it('classifies first click as "click"', () => {
      const { action, newState } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('click')
      expect(action.x).toBe(100)
      expect(action.y).toBe(100)
      expect(newState.clickCount).toBe(1)
      expect(newState.lastClickTime).toBe(1000)
    })

    it('classifies click with tiny movement (< threshold) as click, not drag', () => {
      const { action } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 103, upY: 102, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('click')
    })
  })

  describe('drag', () => {
    it('classifies as drag when movement >= clickDragThresholdPx', () => {
      const { action, newState } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 150, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('drag')
      expect(newState.clickCount).toBe(0)
      expect(newState.lastClickTime).toBe(0)
    })

    it('drag exactly at threshold counts as drag', () => {
      const { action } = classifyMouseAction(
        { downX: 0, downY: 0, upX: 8, upY: 0, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('drag')
    })

    it('drag resets pending multi-click sequence', () => {
      // First, click once
      const afterClick = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      // Then drag from the same spot
      const { action, newState } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 200, upY: 200, timestamp: 1100 },
        afterClick,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('drag')
      expect(newState.clickCount).toBe(0)
    })
  })

  describe('double click', () => {
    it('classifies second rapid same-spot click as dblclick', () => {
      const afterFirst = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      const { action, newState } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1200 },
        afterFirst,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('dblclick')
      expect(newState.clickCount).toBe(2)
    })

    it('two clicks far apart (distance >= multiClickMaxDistance) are both click', () => {
      const afterFirst = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      // Move 10px away (> multiClickMaxDistance=4)
      const { action } = classifyMouseAction(
        { downX: 110, downY: 100, upX: 110, upY: 100, timestamp: 1100 },
        afterFirst,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('click')
    })

    it('two slow clicks (> doubleClickTime) are both click', () => {
      const afterFirst = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      const { action } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 2000 },
        afterFirst,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('click')
    })
  })

  describe('triple click', () => {
    it('classifies third rapid same-spot click as trplclick', () => {
      const afterFirst = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      const afterSecond = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1100 },
        afterFirst,
        DEFAULT_CONFIG,
      ).newState
      const { action, newState } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1200 },
        afterSecond,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('trplclick')
      // State resets to 0 after triple-click
      expect(newState.clickCount).toBe(0)
    })

    it('quadruple-click restarts as single click after triple', () => {
      const afterFirst = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      const afterSecond = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1100 },
        afterFirst,
        DEFAULT_CONFIG,
      ).newState
      const afterThird = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1200 },
        afterSecond,
        DEFAULT_CONFIG,
      ).newState
      // 4th click after reset
      const { action, newState } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1300 },
        afterThird,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('click')
      expect(newState.clickCount).toBe(1)
    })
  })

  describe('boundary timing', () => {
    it('click exactly at doubleClickTime boundary does NOT count as multi-click', () => {
      const afterFirst = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      // Exactly doubleClickTime later → not < doubleClickTime → resets
      const { action } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1500 },
        afterFirst,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('click')
    })

    it('click just under doubleClickTime boundary counts as multi-click', () => {
      const afterFirst = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      const { action } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1499 },
        afterFirst,
        DEFAULT_CONFIG,
      )
      expect(action.type).toBe('dblclick')
    })

    it('uses custom config values (not hardcoded)', () => {
      // With doubleClickTime=100, a 200ms gap should reset
      const cfg = { ...DEFAULT_CONFIG, doubleClickTime: 100 }
      const afterFirst = classifyMouseAction(
        { downX: 0, downY: 0, upX: 0, upY: 0, timestamp: 0 },
        INITIAL_STATE,
        cfg,
      ).newState
      const { action } = classifyMouseAction(
        { downX: 0, downY: 0, upX: 0, upY: 0, timestamp: 200 },
        afterFirst,
        cfg,
      )
      expect(action.type).toBe('click')
    })
  })

  describe('purity', () => {
    it('does not mutate input state', () => {
      const state = { clickCount: 1, lastClickTime: 1000, lastClickPos: { x: 50, y: 50 } }
      const stateCopy = { ...state, lastClickPos: { ...state.lastClickPos } }
      classifyMouseAction(
        { downX: 50, downY: 50, upX: 50, upY: 50, timestamp: 1100 },
        state,
        DEFAULT_CONFIG,
      )
      expect(state).toEqual(stateCopy)
    })

    it('returns independent lastClickPos object (not aliased)', () => {
      const { newState } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      )
      newState.lastClickPos.x = 999
      // Mutating returned state should not affect any internal cache
      expect(INITIAL_STATE.lastClickPos.x).not.toBe(999)
    })
  })

  describe('realistic sequences', () => {
    it('simulates select-then-command workflow: drag → [intervening ops] → click', () => {
      // User drags to select text
      const { action: dragAction, newState: afterDrag } = classifyMouseAction(
        { downX: 100, downY: 100, upX: 300, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      )
      expect(dragAction.type).toBe('drag')
      expect(afterDrag.clickCount).toBe(0)

      // Later: single click to reposition cursor (e.g. before typing)
      const { action: clickAction } = classifyMouseAction(
        { downX: 250, downY: 100, upX: 250, upY: 100, timestamp: 5000 },
        afterDrag,
        DEFAULT_CONFIG,
      )
      expect(clickAction.type).toBe('click')
    })

    it('simulates double-click-select followed by triple-click-select', () => {
      // First double-click: select word
      const after1 = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1000 },
        INITIAL_STATE,
        DEFAULT_CONFIG,
      ).newState
      const after2 = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1100 },
        after1,
        DEFAULT_CONFIG,
      )
      expect(after2.action.type).toBe('dblclick')

      // Then triple-click: select paragraph (fresh sequence after reset? No — continues from 2)
      const after3 = classifyMouseAction(
        { downX: 100, downY: 100, upX: 100, upY: 100, timestamp: 1200 },
        after2.newState,
        DEFAULT_CONFIG,
      )
      expect(after3.action.type).toBe('trplclick')
    })
  })
})
