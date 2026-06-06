import { useEffect, useRef } from 'react'
import type { UIState } from '../../shared/types'

export function useVoiceRecorder(state: UIState, opts: {
  onRecordingComplete: (base64: string) => void
  onError: (error: string) => void
}) {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(() => {
    if (state === 'recording') {
      startRecording()
    } else if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }, [state])

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      })

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      chunksRef.current = []

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const buffer = await blob.arrayBuffer()
        const base64 = btoa(new Uint8Array(buffer).reduce((d, b) => d + String.fromCharCode(b), ''))
        stream.getTracks().forEach(t => t.stop())
        opts.onRecordingComplete(base64)
      }

      recorder.start()
      recorderRef.current = recorder
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : 'Microphone unavailable')
    }
  }
}
