/**
 * OpenCode Auto-Resume Plugin (MIT Licensed)
 * 
 * A simple, free plugin that automatically detects stalled LLM sessions
 * and sends a continuation prompt to resume them.
 * 
 * No subscriptions, no external dependencies, fully open source.
 */

import type { Plugin, PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin"
import type { Event, SessionStatus } from "@opencode-ai/sdk"

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

const autoResumePlugin: Plugin = async (ctx: PluginInput, options: AutoResumeOptions = {}): Promise<Hooks> => {
  const timeoutMs = options.timeoutMs ?? 60_000
  const checkIntervalMs = options.checkIntervalMs ?? 10_000
  const maxRetries = options.maxRetries ?? 5
  const continuePrompt = options.continuePrompt ?? 
    "Continue from where you left off. If you were in the middle of a tool call, complete it. If you were thinking, finish your thought."
  const debug = options.debug ?? false

  const sessions = new Map<string, SessionState>()
  let checkTimer: ReturnType<typeof setInterval> | null = null

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
      
      await ctx.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: continuePrompt }],
        },
      })

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
      // Ask the server for live status of every session. This is more reliable
      // than session.list() + cached events: it also catches sessions that were
      // already busy before this plugin loaded.
      const response = await ctx.client.session.status()
      const statuses = (response.data ?? {}) as Record<string, SessionStatus>

      const now = Date.now()

      for (const [sessionId, status] of Object.entries(statuses)) {
        if (!sessionId || !sessionId.startsWith("ses_")) continue
        const state = getSessionState(sessionId)

        if (status.type === "busy") {
          // Newly discovered busy session: start the clock now, give it a chance.
          if (state.status !== "busy") {
            state.status = "busy"
            state.lastActivityAt = now
            state.isStalled = false
            log("debug", `Watching busy session ${sessionId}`)
            continue
          }

          const timeSinceActivity = now - state.lastActivityAt
          if (timeSinceActivity >= timeoutMs && !state.isStalled && !state.gaveUp) {
            log("warn", `Session ${sessionId} stalled for ${Math.round(timeSinceActivity / 1000)}s (status=busy), attempting resume`)
            state.isStalled = true
            await sendContinuePrompt(sessionId, state)
          }
        } else {
          if (state.status !== status.type) {
            log("debug", `Session ${sessionId} status ${state.status} -> ${status.type}`)
          }
          state.status = status.type
          if (status.type === "idle") {
            state.isStalled = false
            if (state.resumeAttempts > 0) {
              log("info", `Session ${sessionId} recovered (idle), resetting retry counter`)
              state.resumeAttempts = 0
              state.gaveUp = false
            }
          }
          if (status.type === "retry") {
            // OpenCode is retrying internally; treat as activity.
            state.lastActivityAt = now
          }
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

  // Event handler for session activity
  const eventHandler = async ({ event }: { event: Event }) => {
    // Handle session status changes
    if (event.type === "session.status") {
      const sessionId = event.properties.sessionID
      if (sessionId && sessionId.startsWith("ses_")) {
        updateStatus(sessionId, event.properties.status)
      }
      return
    }

    // Update activity on message/tool events for busy sessions
    if (event.type.startsWith("message.") || event.type.startsWith("tool.") || event.type.startsWith("command.")) {
      const sessionId = (
        (event.properties as Record<string, unknown> | undefined)?.sessionID as string
      )
      if (sessionId && sessionId.startsWith("ses_")) {
        updateActivity(sessionId)
      }
    }
  }

  // Config handler for runtime option changes
  const configHandler = async (_input: { plugin?: Array<string | [string, PluginOptions]> }) => {
    // Config changes would require restart for timeout/interval changes
    log("debug", "Config updated (runtime changes require restart for timeout/interval)")
  }

  return {
    event: eventHandler,
    config: configHandler,
    async dispose() {
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      sessions.clear()
      log("info", "Auto-resume plugin disposed")
    },
  }
}

export default autoResumePlugin