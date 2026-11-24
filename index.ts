/**
 * OpenCode Auto-Resume Plugin (MIT Licensed)
 * 
 * A simple, free plugin that automatically detects stalled LLM sessions
 * and sends a continuation prompt to resume them.
 * 
 * No subscriptions, no external dependencies, fully open source.
 */

import { Plugin } from "@opencode/plugin"
import type { SessionStatus } from "@opencode/client"
import type { SessionPromptInput } from "@opencode/client"

interface AutoResumeOptions {
  /** Time in ms before a session is considered stalled (default: 60000) */
  timeoutMs?: number
  /** How often to check for stalled sessions in ms (default: 10000) */
  checkIntervalMs?: number
  /** Maximum number of auto-resume attempts per session (default: 5) */
  maxRetries?: number
  /** Custom prompt to send when resuming */
  continuePrompt?: string
  /** Enable debug logging */
  debug?: boolean
}

interface SessionState {
  sessionId: string
  lastActivityAt: number
  resumeAttempts: number
  isStalled: boolean
  gaveUp: boolean
  status: "idle" | "busy" | "retry"
}

export default Plugin.define({
  id: "auto-resume-lite",
  async setup(ctx) {
    const timeoutMs = (ctx.options?.timeoutMs as number) ?? 60_000
    const checkIntervalMs = (ctx.options?.checkIntervalMs as number) ?? 10_000
    const maxRetries = (ctx.options?.maxRetries as number) ?? 5
    const continuePrompt = (ctx.options?.continuePrompt as string) ?? 
      "Continue from where you left off. If you were in the middle of a tool call, complete it. If you were thinking, finish your thought."
    const debug = (ctx.options?.debug as boolean) ?? false

    const sessions = new Map<string, SessionState>()
    let checkTimer: ReturnType<typeof setInterval> | null = null
    let abortController = new AbortController()

    const log = (level: "debug" | "info" | "warn" | "error", msg: string) => {
      if (level === "debug" && !debug) return
      const prefix = `[auto-resume]`
      console[level === "debug" ? "log" : level](`${prefix} ${msg}`)
    }

    function getSessionState(sessionId: string): SessionState {
      let state = sessions.get(sessionId)
      if (!state) {
        state = {
          sessionId,
          lastActivityAt: Date.now(),
          resumeAttempts: 0,
          isStalled: false,
          gaveUp: false,
          status: "idle",
        }
        sessions.set(sessionId, state)
      }
      return state
    }

    function updateActivity(sessionId: string) {
      const state = sessions.get(sessionId)
      if (state && !state.gaveUp) {
        state.lastActivityAt = Date.now()
        state.isStalled = false
      }
    }

    function updateStatus(sessionId: string, status: SessionStatus) {
      const state = sessions.get(sessionId)
      if (!state) return
      
      if (status.type === "busy") {
        state.status = "busy"
        updateActivity(sessionId)
      } else if (status.type === "idle") {
        state.status = "idle"
        // Reset retry count when session goes idle naturally
        if (state.resumeAttempts > 0) {
          state.resumeAttempts = 0
          state.gaveUp = false
        }
      } else if (status.type === "retry") {
        state.status = "retry"
        updateActivity(sessionId)
      }
    }

    async function sendContinuePrompt(sessionId: string, state: SessionState): Promise<boolean> {
      if (state.resumeAttempts >= maxRetries) {
        log("warn", `Session ${sessionId} exceeded max retries (${maxRetries}), giving up`)
        state.gaveUp = true
        return false
      }

      if (state.gaveUp) {
        return false
      }

      try {
        log("info", `Sending continue prompt to session ${sessionId} (attempt ${state.resumeAttempts + 1}/${maxRetries})`)
        
        const prompt: SessionPromptInput = {
          sessionID: sessionId,
          text: continuePrompt,
          delivery: "steer",
        }
        
        await ctx.session.prompt(prompt)

        state.resumeAttempts++
        state.lastActivityAt = Date.now()
        state.isStalled = false
        
        log("info", `Continue prompt sent successfully to ${sessionId}`)
        return true
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        log("error", `Failed to send continue prompt to ${sessionId}: ${msg}`)
        return false
      }
    }

    async function checkSessions() {
      try {
        // Get live status for all sessions
        const response = await ctx.session.list({ limit: 100 })
        const sessionsList = response.data ?? []
        
        const now = Date.now()
        
        for (const session of sessionsList) {
          const sessionId = session.id
          if (!sessionId || !sessionId.startsWith("ses_")) continue

          const state = getSessionState(sessionId)
          
          // Only check busy sessions
          if (state.status !== "busy") {
            continue
          }

          // Check if session has stalled
          const timeSinceActivity = now - state.lastActivityAt
          
          if (timeSinceActivity >= timeoutMs && !state.isStalled && !state.gaveUp) {
            log("warn", `Session ${sessionId} stalled for ${Math.round(timeSinceActivity / 1000)}s (status=busy), attempting resume`)
            state.isStalled = true
            await sendContinuePrompt(sessionId, state)
          } else if (state.isStalled && timeSinceActivity < timeoutMs) {
            // Session recovered on its own
            log("debug", `Session ${sessionId} recovered on its own`)
            state.isStalled = false
            state.resumeAttempts = 0
          }
        }

        // Clean up old session states (inactive for > 1 hour)
        for (const [sessionId, state] of sessions) {
          if (now - state.lastActivityAt > 3_600_000) {
            sessions.delete(sessionId)
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        log("error", `Error checking sessions: ${msg}`)
      }
    }

    // Start the monitoring timer
    checkTimer = setInterval(checkSessions, checkIntervalMs)
    log("info", `Auto-resume started (timeout: ${timeoutMs}ms, check interval: ${checkIntervalMs}ms, max retries: ${maxRetries})`)

    // Event handler for session activity - subscribe to session.status events
    const eventStream = ctx.event.subscribe({ types: ["session.status"], signal: abortController.signal })
    
    // Process events in background
    ;(async () => {
      for await (const event of eventStream) {
        if (event.type === "session.status") {
          const sessionId = event.data.sessionID
          if (sessionId && sessionId.startsWith("ses_")) {
            updateStatus(sessionId, event.data.status)
          }
        }
      }
    })()

    // Return cleanup function
    return () => {
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      abortController.abort()
      sessions.clear()
      log("info", "Auto-resume plugin disposed")
    }
  }
})