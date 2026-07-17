import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webRoot, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const protectedPaths = ["web/.data", "web/.next", "web/node_modules", "web/tsconfig.tsbuildinfo"];

run("git", ["diff", "--check"], repoRoot, "Git whitespace check");
const trackedProtected = run("git", ["ls-files", ...protectedPaths], repoRoot, "Runtime/build artifact tracking check", { capture: true });
if (trackedProtected.trim()) fail(`These runtime/build files should not be committed:\n${trackedProtected.trim()}`);

run(pnpm, ["run", "format:check"], webRoot, "Prettier check");
run(pnpm, ["run", "typecheck"], webRoot, "TypeScript check");
run(pnpm, ["run", "build"], webRoot, "Next.js low-memory build", {
    env: {
        NEXT_BUILD_CPUS: "1",
        NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=1024",
        NEXT_TELEMETRY_DISABLED: "1",
    },
});

const standaloneServer = path.join(webRoot, ".next", "standalone", "server.js");
if (!existsSync(standaloneServer)) fail("Build completed, but .next/standalone/server.js was not found.");

console.log("\nXSVO release check passed.");
console.log("Before publishing, still manually verify: home, canvas, points modal, image workbench, video workbench, and admin dashboard.");

function run(command, args, cwd, label, options = {}) {
    console.log(`\n> ${label}`);
    const executable = commandForPlatform(command, args);
    const result = spawnSync(executable.command, executable.args, {
        cwd,
        env: { ...process.env, ...(options.env || {}) },
        encoding: "utf8",
        stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    if (options.capture) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
    }

    if (result.error) fail(`${label} could not start: ${result.error.message}`);
    if (result.status !== 0) fail(`${label} failed.`);
    return result.stdout || "";
}

function commandForPlatform(command, args) {
    if (process.platform !== "win32") return { command, args };
    return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")],
    };
}

function quoteWindowsArg(value) {
    if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) return value;
    return `"${value.replaceAll('"', '\\"')}"`;
}

function fail(message) {
    console.error(`\n${message}`);
    process.exit(1);
}
