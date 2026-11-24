/**
 * OpenCode Auto-Resume Plugin (MIT Licensed)
 *
 * A simple, free plugin that automatically detects stalled LLM sessions
 * and sends a continuation prompt to resume them.
 *
 * No subscriptions, no external dependencies, fully open source.
 */
import { Plugin } from "@opencode/plugin";
export default Plugin.define({
    id: "auto-resume-lite",
    async setup(ctx) {
        const timeoutMs = ctx.options?.timeoutMs ?? 60_000;
        const checkIntervalMs = ctx.options?.checkIntervalMs ?? 10_000;
        const maxRetries = ctx.options?.maxRetries ?? 5;
        const continuePrompt = ctx.options?.continuePrompt ??
            "Continue from where you left off. If you were in the middle of a tool call, complete it. If you were thinking, finish your thought.";
        const debug = ctx.options?.debug ?? false;
        const sessions = new Map();
        let checkTimer = null;
        let abortController = new AbortController();
        const log = (level, msg) => {
            if (level === "debug" && !debug)
                return;
            const prefix = `[auto-resume]`;
            console[level === "debug" ? "log" : level](`${prefix} ${msg}`);
        };
        function getSessionState(sessionId) {
            let state = sessions.get(sessionId);
            if (!state) {
                state = {
                    sessionId,
                    lastActivityAt: Date.now(),
                    resumeAttempts: 0,
                    isStalled: false,
                    gaveUp: false,
                    status: "idle",
                };
                sessions.set(sessionId, state);
            }
            return state;
        }
        function updateActivity(sessionId) {
            const state = sessions.get(sessionId);
            if (state && !state.gaveUp) {
                state.lastActivityAt = Date.now();
                state.isStalled = false;
            }
        }
        function updateStatus(sessionId, status) {
            const state = sessions.get(sessionId);
            if (!state)
                return;
            if (status.type === "busy") {
                state.status = "busy";
                updateActivity(sessionId);
            }
            else if (status.type === "idle") {
                state.status = "idle";
                // Reset retry count when session goes idle naturally
                if (state.resumeAttempts > 0) {
                    state.resumeAttempts = 0;
                    state.gaveUp = false;
                }
            }
            else if (status.type === "retry") {
                state.status = "retry";
                updateActivity(sessionId);
            }
        }
        async function sendContinuePrompt(sessionId, state) {
            if (state.resumeAttempts >= maxRetries) {
                log("warn", `Session ${sessionId} exceeded max retries (${maxRetries}), giving up`);
                state.gaveUp = true;
                return false;
            }
            if (state.gaveUp) {
                return false;
            }
            try {
                log("info", `Sending continue prompt to session ${sessionId} (attempt ${state.resumeAttempts + 1}/${maxRetries})`);
                const prompt = {
                    sessionID: sessionId,
                    text: continuePrompt,
                    delivery: "steer",
                };
                await ctx.session.prompt(prompt);
                state.resumeAttempts++;
                state.lastActivityAt = Date.now();
                state.isStalled = false;
                log("info", `Continue prompt sent successfully to ${sessionId}`);
                return true;
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                log("error", `Failed to send continue prompt to ${sessionId}: ${msg}`);
                return false;
            }
        }
        async function checkSessions() {
            try {
                // Get live status for all sessions
                const response = await ctx.session.list({ limit: 100 });
                const sessionsList = response.data ?? [];
                const now = Date.now();
                for (const session of sessionsList) {
                    const sessionId = session.id;
                    if (!sessionId || !sessionId.startsWith("ses_"))
                        continue;
                    const state = getSessionState(sessionId);
                    // Only check busy sessions
                    if (state.status !== "busy") {
                        continue;
                    }
                    // Check if session has stalled
                    const timeSinceActivity = now - state.lastActivityAt;
                    if (timeSinceActivity >= timeoutMs && !state.isStalled && !state.gaveUp) {
                        log("warn", `Session ${sessionId} stalled for ${Math.round(timeSinceActivity / 1000)}s (status=busy), attempting resume`);
                        state.isStalled = true;
                        await sendContinuePrompt(sessionId, state);
                    }
                    else if (state.isStalled && timeSinceActivity < timeoutMs) {
                        // Session recovered on its own
                        log("debug", `Session ${sessionId} recovered on its own`);
                        state.isStalled = false;
                        state.resumeAttempts = 0;
                    }
                }
                // Clean up old session states (inactive for > 1 hour)
                for (const [sessionId, state] of sessions) {
                    if (now - state.lastActivityAt > 3_600_000) {
                        sessions.delete(sessionId);
                    }
                }
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                log("error", `Error checking sessions: ${msg}`);
            }
        }
        // Start the monitoring timer
        checkTimer = setInterval(checkSessions, checkIntervalMs);
        log("info", `Auto-resume started (timeout: ${timeoutMs}ms, check interval: ${checkIntervalMs}ms, max retries: ${maxRetries})`);
        // Event handler for session activity - subscribe to session.status events
        const eventStream = ctx.event.subscribe({ types: ["session.status"], signal: abortController.signal });
        (async () => {
            for await (const event of eventStream) {
                if (event.type === "session.status") {
                    const sessionId = event.data.sessionID;
                    if (sessionId && sessionId.startsWith("ses_")) {
                        updateStatus(sessionId, event.data.status);
                    }
                }
            }
        })();
        // Return cleanup function
        return () => {
            if (checkTimer) {
                clearInterval(checkTimer);
                checkTimer = null;
            }
            abortController.abort();
            sessions.clear();
            log("info", "Auto-resume plugin disposed");
        };
    }
});
