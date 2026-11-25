// AppData/Local/Temp/opencode/repo/index.ts
import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
var TIMEOUT_RE = /time(d)?[\s_-]?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|UND_ERR|socket hang up|stream (ended|closed|terminated)|terminated|\b(408|499|504)\b|gateway|rate.?limit|overloaded|provider returned error/i;
var PERMANENT_RE = /\b(400|401|403|404|422)\b|invalid.{0,16}(api.?key|token)|unauthorized|forbidden|model.{0,16}not.{0,8}found|context.{0,16}(length|window)/i;
var safeJson = (value) => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};
var short = (id) => id.length > 14 ? `${id.slice(0, 14)}\u2026` : id;
var index_default = Plugin.define({
  id: "timeout-resume",
  async setup(ctx) {
    const opts = ctx.options ?? {};
    const num = (key2, fallback) => typeof opts[key2] === "number" && Number.isFinite(opts[key2]) ? opts[key2] : fallback;
    const cfg = {
      stallMs: Math.max(1e4, num("stallMs", 12e4)),
      checkEveryMs: Math.max(1e3, num("checkEveryMs", 8e3)),
      maxNudges: Math.max(1, Math.floor(num("maxNudges", 4))),
      baseDelayMs: Math.max(0, num("baseDelayMs", 2500)),
      maxDelayMs: Math.max(1e3, num("maxDelayMs", 45e3)),
      cooldownMs: Math.max(5e3, num("cooldownMs", 6e4)),
      maxCooldownMs: Math.max(1e4, num("maxCooldownMs", 30 * 6e4)),
      failureGraceMs: Math.max(0, num("failureGraceMs", 3e3)),
      interruptGraceMs: Math.max(0, num("interruptGraceMs", 1500)),
      startTimeoutMs: Math.max(5e3, num("startTimeoutMs", 2e4)),
      maxToolRunMs: Math.max(6e4, num("maxToolRunMs", 60 * 6e4)),
      maxRecoveryAgeMs: Math.max(6e4, num("maxRecoveryAgeMs", 6 * 60 * 6e4)),
      forgetAfterMs: Math.max(6e4, num("forgetAfterMs", 30 * 6e4)),
      debug: opts.debug === true,
      nudgeText: typeof opts.nudgeText === "string" ? opts.nudgeText : "Your previous response was interrupted by a timeout or stall. Continue exactly where you left off and finish the task. Do not restart or repeat work that is already done.",
      logFile: typeof opts.logFile === "string" && opts.logFile.length > 0 ? opts.logFile : void 0
    };
    const sessions = /* @__PURE__ */ new Map();
    const controller = new AbortController();
    let disposed = false;
    const log = (level, ...args) => {
      if (level === "debug" && !cfg.debug) return;
      const text = args.map((arg) => typeof arg === "string" ? arg : safeJson(arg)).join(" ");
      if (cfg.debug || level === "warn") console.log("[timeout-resume]", text);
      if (cfg.logFile) {
        try {
          appendFileSync(cfg.logFile, `${(/* @__PURE__ */ new Date()).toISOString()} [${level}] ${text}
`);
        } catch {
        }
      }
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const get = (id) => {
      let state = sessions.get(id);
      if (!state) {
        state = {
          busy: false,
          lastActivity: Date.now(),
          lastFailureAt: 0,
          lastNudgeAt: 0,
          lastAttemptAt: 0,
          nudges: 0,
          bursts: 0,
          cooldownUntil: 0,
          nudging: false,
          errored: false,
          awaitingStartAt: 0,
          userStopped: false,
          selfInterruptUntil: 0,
          failureToken: 0,
          tools: /* @__PURE__ */ new Map(),
          permissions: /* @__PURE__ */ new Set()
        };
        sessions.set(id, state);
      }
      return state;
    };
    const resetBudget = (state) => {
      state.nudges = 0;
      state.bursts = 0;
      state.cooldownUntil = 0;
      state.awaitingStartAt = 0;
    };
    const sessionIdOf = (event) => event?.sessionID ?? event?.sessionId ?? event?.properties?.sessionID ?? event?.properties?.sessionId ?? event?.data?.sessionID ?? event?.data?.sessionId ?? event?.properties?.info?.sessionID ?? event?.info?.sessionID;
    const errorOf = (event) => event?.data?.error ?? event?.error ?? event?.properties?.error;
    const isBusy = (info) => {
      const time = info?.time;
      if (!time) return false;
      const busy = typeof time.busy === "number" ? time.busy : 0;
      const idle = typeof time.idle === "number" ? time.idle : 0;
      return busy > idle;
    };
    const refresh = async (id) => {
      try {
        return await ctx.session.get({ sessionID: id });
      } catch {
        return void 0;
      }
    };
    const cooldownFor = (bursts) => {
      const exponent = Math.min(Math.max(0, bursts - 1), 10);
      return Math.min(cfg.cooldownMs * 2 ** exponent, cfg.maxCooldownMs);
    };
    async function nudge(id, reason, interruptFirst = false) {
      if (disposed) return;
      const state = get(id);
      if (state.nudging) return;
      const now = Date.now();
      if (now < state.cooldownUntil) return;
      const before = await refresh(id);
      if (!before) {
        sessions.delete(id);
        return;
      }
      if (isBusy(before) && !interruptFirst) {
        log("debug", `${short(id)} is already active; skipping resume`);
        return;
      }
      if (state.nudges >= cfg.maxNudges) {
        state.nudges = 0;
        state.bursts += 1;
        const cooldown = cooldownFor(state.bursts);
        state.cooldownUntil = now + cooldown;
        log(
          "warn",
          `${short(id)} used ${cfg.maxNudges} resume attempts without a clean turn; cooling down for ${Math.round(cooldown / 1e3)}s`
        );
        return;
      }
      state.lastAttemptAt = now;
      state.nudging = true;
      try {
        const attempt = state.nudges + 1;
        const delay = Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs);
        log(
          "info",
          `timeout detected (${reason}); resuming ${short(id)} in ${delay}ms (attempt ${attempt}/${cfg.maxNudges}, burst ${state.bursts + 1})`
        );
        if (interruptFirst) {
          state.selfInterruptUntil = Date.now() + Math.max(1e4, delay + cfg.interruptGraceMs);
          try {
            await ctx.session.interrupt({ sessionID: id, resume: false });
          } catch (err) {
            log("debug", `interrupt failed for ${short(id)}: ${String(err)}`);
          }
          await sleep(Math.min(cfg.interruptGraceMs, Math.max(0, delay)));
        } else {
          await sleep(delay);
        }
        if (disposed) return;
        const latest = await refresh(id);
        if (!latest) {
          sessions.delete(id);
          return;
        }
        if (isBusy(latest)) {
          log("info", `skipping resume for ${short(id)}: session became active on its own`);
          return;
        }
        if (latest.outcome === "succeeded") {
          state.errored = false;
          resetBudget(state);
          return;
        }
        state.errored = false;
        state.awaitingStartAt = Date.now();
        await ctx.session.prompt({ sessionID: id, text: cfg.nudgeText });
        state.nudges += 1;
        state.lastNudgeAt = Date.now();
        state.lastActivity = Date.now();
        log("info", `resume sent to ${short(id)} (attempt ${state.nudges}/${cfg.maxNudges})`);
      } catch (err) {
        state.errored = true;
        state.awaitingStartAt = 0;
        log("warn", `resume failed for ${short(id)}: ${String(err)}`);
      } finally {
        state.nudging = false;
      }
    }
    function scheduleFailureNudge(id, reason, retryAfterMs) {
      const state = get(id);
      state.errored = true;
      state.busy = false;
      state.tools.clear();
      state.lastFailureAt = Date.now();
      state.failureToken += 1;
      const token = state.failureToken;
      if (retryAfterMs && retryAfterMs > 0) {
        const wait = Math.min(retryAfterMs, cfg.maxCooldownMs);
        state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + wait);
        log("info", `${short(id)} provider asked to wait ${Math.round(wait / 1e3)}s before retrying`);
        return;
      }
      setTimeout(() => {
        if (disposed) return;
        const current = sessions.get(id);
        if (!current || current.failureToken !== token) return;
        void nudge(id, reason, false);
      }, cfg.failureGraceMs);
    }
    function handle(event) {
      const type = event?.type ?? "";
      const id = sessionIdOf(event);
      if (cfg.debug) log("debug", "event", type, id ? short(id) : "(no session)");
      if (!id) return;
      const state = get(id);
      state.lastActivity = Date.now();
      switch (type) {
        case "session.execution.started":
          state.busy = true;
          state.errored = false;
          state.awaitingStartAt = 0;
          state.userStopped = false;
          state.failureToken += 1;
          state.tools.clear();
          state.permissions.clear();
          break;
        case "session.execution.succeeded":
          state.busy = false;
          state.errored = false;
          state.userStopped = false;
          state.tools.clear();
          state.permissions.clear();
          state.failureToken += 1;
          resetBudget(state);
          break;
        case "session.execution.failed": {
          const error = errorOf(event);
          const text = `${error?.type ?? ""} ${error?.message ?? ""} ${error?.status ?? ""} ${safeJson(error)}`;
          if (TIMEOUT_RE.test(text)) {
            scheduleFailureNudge(
              id,
              `execution failed: ${error?.type ?? "unknown error"}`,
              typeof error?.retryAfterMs === "number" ? error.retryAfterMs : void 0
            );
          } else {
            state.busy = false;
            state.errored = false;
            state.awaitingStartAt = 0;
            state.tools.clear();
            state.lastFailureAt = Date.now();
            state.failureToken += 1;
            log("debug", `${short(id)} failed with a non-timeout error; not resuming`);
          }
          break;
        }
        case "session.execution.interrupted": {
          state.busy = false;
          state.tools.clear();
          state.permissions.clear();
          state.failureToken += 1;
          const reason = event?.data?.reason ?? event?.reason;
          if (reason === "inactivity") {
            scheduleFailureNudge(id, "execution interrupted for inactivity");
          } else if (reason === "user") {
            if (Date.now() < state.selfInterruptUntil) {
              log("debug", `${short(id)} interrupted for stall recovery`);
            } else {
              state.userStopped = true;
              state.errored = false;
              resetBudget(state);
            }
          }
          break;
        }
        case "session.idle":
          state.busy = false;
          state.tools.clear();
          state.permissions.clear();
          state.failureToken += 1;
          if (!state.errored) resetBudget(state);
          break;
        case "session.retry.scheduled":
          state.busy = true;
          state.errored = false;
          state.awaitingStartAt = 0;
          break;
        case "session.step.failed":
          state.lastFailureAt = Date.now();
          break;
        case "session.step.started":
        case "session.text.started":
        case "session.reasoning.started":
          state.busy = true;
          state.awaitingStartAt = 0;
          break;
        case "permission.asked":
          state.permissions.add(String(event?.data?.id ?? event?.id ?? "unknown"));
          break;
        case "permission.replied":
          state.permissions.delete(String(event?.data?.requestID ?? event?.requestID ?? "unknown"));
          break;
        case "session.tool.called": {
          const callID = String(event?.data?.id ?? event?.id ?? "");
          if (callID) state.tools.set(callID, Date.now());
          state.busy = true;
          state.awaitingStartAt = 0;
          break;
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const callID = String(event?.data?.id ?? event?.id ?? "");
          if (callID) state.tools.delete(callID);
          break;
        }
        case "session.deleted":
          sessions.delete(id);
          break;
        default:
          break;
      }
    }
    await ctx.session.hook("retry", (event) => {
      const error = event?.error ?? {};
      const text = `${error.type ?? ""} ${error.message ?? ""} ${error.status ?? ""}`;
      if (PERMANENT_RE.test(text)) return;
      if (!event?.decision?.retry && TIMEOUT_RE.test(text)) {
        const retryAfter = typeof error.retryAfterMs === "number" && error.retryAfterMs >= 0 ? Math.min(error.retryAfterMs, cfg.maxCooldownMs) : void 0;
        event.decision = {
          retry: true,
          delay: retryAfter ?? Math.min(cfg.baseDelayMs * 2 ** Math.max(0, (event.attempt ?? 1) - 1), cfg.maxDelayMs)
        };
      }
    });
    await ctx.tool.hook("execute.before", (event) => {
      const id = sessionIdOf(event);
      if (!id) return;
      const state = get(id);
      state.lastActivity = Date.now();
      state.tools.set(String(event?.id ?? "unknown"), Date.now());
    });
    await ctx.tool.hook("execute.after", (event) => {
      const id = sessionIdOf(event);
      if (!id) return;
      const state = get(id);
      state.lastActivity = Date.now();
      state.tools.delete(String(event?.id ?? "unknown"));
    });
    void (async () => {
      let attempt = 0;
      while (!disposed && !controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            attempt = 0;
            handle(event);
          }
          if (disposed || controller.signal.aborted) break;
          log("warn", "event stream ended; reconnecting");
        } catch (err) {
          if (disposed || controller.signal.aborted) break;
          log("warn", `event stream error: ${String(err)}; reconnecting`);
        }
        await sleep(Math.min(1e3 * 2 ** attempt, 3e4));
        attempt = Math.min(attempt + 1, 5);
      }
    })();
    const timer = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      for (const [id, state] of sessions) {
        for (const [callID, startedAt] of state.tools) {
          if (now - startedAt > cfg.maxToolRunMs) {
            state.tools.delete(callID);
            log(
              "warn",
              `${short(id)} tool ${callID} has been running for ${Math.round((now - startedAt) / 6e4)}m; no longer blocking resume`
            );
          }
        }
        if (!state.busy && !state.errored && !state.nudging && now - state.lastActivity > cfg.forgetAfterMs) {
          sessions.delete(id);
          continue;
        }
        if (state.nudging || now < state.cooldownUntil) continue;
        if (state.busy) {
          if (state.permissions.size > 0 || state.tools.size > 0) continue;
          if (now - state.lastActivity > cfg.stallMs) {
            void nudge(id, `no activity for ${Math.round((now - state.lastActivity) / 1e3)}s`, true);
          }
          continue;
        }
        if (state.userStopped) continue;
        if (state.awaitingStartAt && now - state.awaitingStartAt > cfg.startTimeoutMs) {
          state.awaitingStartAt = 0;
          state.errored = true;
          state.lastFailureAt = now;
          log("warn", `${short(id)} resume prompt was accepted but no execution started; retrying`);
        }
        if (state.errored) {
          if (now - state.lastFailureAt > cfg.maxRecoveryAgeMs) continue;
          if (now - state.lastAttemptAt < cfg.baseDelayMs) continue;
          if (state.awaitingStartAt && now - state.awaitingStartAt < cfg.startTimeoutMs) continue;
          void nudge(id, "session is idle after a failure", false);
        }
      }
    }, cfg.checkEveryMs);
    log("info", `ready (stallMs=${cfg.stallMs}, maxNudges=${cfg.maxNudges}, cooldownMs=${cfg.cooldownMs})`);
    const cleanup = async () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      controller.abort();
      sessions.clear();
    };
    const key = /* @__PURE__ */ Symbol.for("opencode.timeout-resume.active");
    const root = globalThis;
    const previous = root[key];
    if (typeof previous === "function") {
      try {
        await previous();
      } catch {
      }
    }
    root[key] = cleanup;
    return async () => {
      if (root[key] === cleanup) delete root[key];
      await cleanup();
    };
  }
});
export {
  index_default as default
};
