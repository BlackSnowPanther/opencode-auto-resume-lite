/**
 * timeout-resume / auto-resume-lite (MIT Licensed)
 *
 * Keeps an OpenCode V2 session moving when a provider or service times out or
 * stalls. Per-burst retry budget with a growing cooldown, so it never gives up
 * permanently. Dependency-free at runtime (only @opencode/plugin).
 */
import { Plugin } from "@opencode/plugin";
declare const _default: Plugin.Plugin;
export default _default;