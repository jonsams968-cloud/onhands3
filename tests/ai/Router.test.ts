import { describe, it, expect } from 'vitest'
import { Router } from '../../src/main/ai/Router'

describe('Router', () => {
  const router = new Router()

  describe('direct mode (text-only tasks)', () => {
    it('routes translation to direct', () => {
      expect(router.decide('翻译成英文')).toBe('direct')
    })

    it('routes greetings to direct', () => {
      expect(router.decide('你好')).toBe('direct')
    })

    it('routes memory to direct', () => {
      expect(router.decide('记住我的名字是小明')).toBe('direct')
      expect(router.decide('提醒我下午开会')).toBe('direct')
    })
  })

  describe('agent mode (everything else)', () => {
    it('routes file rename to agent', () => {
      expect(router.decide('重命名这些文件')).toBe('agent')
      expect(router.decide('将他们的名字改为日期')).toBe('agent')
      expect(router.decide('改名')).toBe('agent')
    })

    it('routes file operations to agent', () => {
      expect(router.decide('删除这个文件')).toBe('agent')
      expect(router.decide('复制到桌面')).toBe('agent')
    })

    it('routes questions about data to agent', () => {
      expect(router.decide('什么是量子计算')).toBe('agent')
      expect(router.decide('明天天气怎么样')).toBe('agent')
      expect(router.decide('如何学习编程')).toBe('agent')
    })

    it('routes Excel operations to agent', () => {
      expect(router.decide('求和')).toBe('agent')
    })

    it('routes coding to agent', () => {
      expect(router.decide('写一个Python脚本')).toBe('agent')
    })

    it('routes summary/extraction to agent', () => {
      expect(router.decide('总结这篇文章')).toBe('agent')
      expect(router.decide('提取关键信息')).toBe('agent')
    })

    it('routes unknown commands to agent (safe default)', () => {
      expect(router.decide('随便说说')).toBe('agent')
      expect(router.decide('帮我把这个整理一下')).toBe('agent')
    })
  })
})
