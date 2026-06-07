import { useEffect, useRef } from 'react'
import type { UIState } from '../../shared/types'

export function useVoiceRecorder(state: UIState, opts: {
  onRecordingComplete: (base64: string) => void
  onError: (error: string) => void
}) {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const peakAmplitudeRef = useRef(0)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const monitorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (state === 'recording') {
      startRecording()
    } else if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }, [state])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (monitorIntervalRef.current) clearInterval(monitorIntervalRef.current)
      audioContextRef.current?.close()
    }
  }, [])

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      })

      // Set up audio analysis to track peak amplitude
      const audioCtx = new AudioContext()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      analyserRef.current = analyser
      peakAmplitudeRef.current = 0

      // Monitor amplitude periodically (every 100ms)
      const dataArray = new Float32Array(analyser.fftSize)
      monitorIntervalRef.current = setInterval(() => {
        if (!analyserRef.current) return
        analyserRef.current.getFloatTimeDomainData(dataArray)
        for (let i = 0; i < dataArray.length; i++) {
          const abs = Math.abs(dataArray[i])
          if (abs > peakAmplitudeRef.current) {
            peakAmplitudeRef.current = abs
          }
        }
      }, 100)

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      chunksRef.current = []

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }

      recorder.onstop = async () => {
        // Stop monitoring
        if (monitorIntervalRef.current) {
          clearInterval(monitorIntervalRef.current)
          monitorIntervalRef.current = null
        }

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const peakAmplitude = peakAmplitudeRef.current
        peakAmplitudeRef.current = 0

        // Clean up audio context and stream
        stream.getTracks().forEach(t => t.stop())
        audioContextRef.current?.close()
        audioContextRef.current = null
        analyserRef.current = null

        // Check if audio was too quiet (likely silence / mic off / background noise)
        // Threshold: 0.02 = very quiet, normal speech is 0.1-0.5
        if (peakAmplitude < 0.02) {
          console.log(`[voice] Peak amplitude ${peakAmplitude.toFixed(4)} too low — treating as silence`)
          opts.onError('silence')
          return
        }

        // Also reject very tiny blobs (< 500 bytes = essentially no audio data)
        if (blob.size < 500) {
          console.log(`[voice] Blob size ${blob.size} too small — treating as silence`)
          opts.onError('silence')
          return
        }

        const buffer = await blob.arrayBuffer()
        const base64 = btoa(new Uint8Array(buffer).reduce((d, b) => d + String.fromCharCode(b), ''))
        opts.onRecordingComplete(base64)
      }

      recorder.start()
      recorderRef.current = recorder
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : 'Microphone unavailable')
    }
  }
}
