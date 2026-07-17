import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HASH_ALGORITHM = "pbkdf2_sha256";
const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const BACKUP_LIMIT = 3;
const BACKUP_PATTERN = /^auth-password-reset-.+\.json$/;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
    printHelp();
    process.exit(0);
}

const dataDir = path.resolve(args.dataDir || process.env.XSVO_DATA_DIR || process.env.VOZEB_DATA_DIR || path.join(webRoot, ".data"));
const authFile = path.join(dataDir, "auth.json");

if (args.listAdmins) {
    listAdmins(await readAuthDb());
    process.exit(0);
}

if (!args.password) fail("Missing --password.");
if (args.password.length < 8) fail("New password must be at least 8 characters.");

const db = await readAuthDb();
const user = findAdminUser(db);
const backupFile = await backupAuthFile();

user.passwordHash = hashPassword(args.password);
user.updatedAt = new Date().toISOString();
db.sessions = Array.isArray(db.sessions) ? db.sessions.filter((session) => session.userId !== user.id) : [];

await writeAuthDb(db);
const removedBackupCount = await pruneBackups();

console.log(`Admin password reset: ${user.username} (${user.displayName || "no display name"})`);
console.log("Old sessions for this admin user were removed. Sign in again with the new password.");
console.log(`Backup written: ${backupFile}`);
if (removedBackupCount > 0) console.log(`Pruned ${removedBackupCount} old password reset backup(s).`);

function parseArgs(argv) {
    const parsed = { dataDir: "", email: "", help: false, id: "", listAdmins: false, password: "", username: "" };
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        const next = argv[index + 1];
        if (item === "--help" || item === "-h") parsed.help = true;
        else if (item === "--list-admins") parsed.listAdmins = true;
        else if (item === "--data-dir") (parsed.dataDir = readValue(item, next)), (index += 1);
        else if (item === "--email") (parsed.email = readValue(item, next).trim().toLowerCase()), (index += 1);
        else if (item === "--id") (parsed.id = readValue(item, next).trim()), (index += 1);
        else if (item === "--password") (parsed.password = readValue(item, next)), (index += 1);
        else if (item === "--username") (parsed.username = readValue(item, next).trim().toLowerCase()), (index += 1);
        else fail(`Unknown argument: ${item}`);
    }
    return parsed;
}

function readValue(name, value) {
    if (!value || value.startsWith("--")) fail(`${name} is missing a value.`);
    return value;
}

async function readAuthDb() {
    let raw = "";
    try {
        raw = await readFile(authFile, "utf8");
    } catch {
        fail(`Cannot read auth database: ${authFile}`);
    }

    try {
        const db = JSON.parse(raw);
        if (!db || typeof db !== "object" || !Array.isArray(db.users)) throw new Error("invalid auth database");
        return db;
    } catch {
        fail(`${authFile} is not a valid auth database JSON file.`);
    }
}

function findAdminUser(db) {
    const admins = db.users.filter((user) => user?.role === "admin");
    if (!admins.length) fail("No admin user found in auth database.");
    if (!args.id && !args.username && !args.email) {
        listAdmins(db);
        fail("Specify exactly one admin with --username, --email, or --id before resetting a password.");
    }

    let matched = admins;
    if (args.id) matched = matched.filter((user) => user.id === args.id);
    if (args.username) matched = matched.filter((user) => String(user.username || "").toLowerCase() === args.username);
    if (args.email) matched = matched.filter((user) => String(user.email || "").toLowerCase() === args.email);

    if (matched.length === 1) return matched[0];
    listAdmins(db);
    fail(matched.length ? "Multiple admin users matched. Add a more specific selector." : "No matching admin user found.");
}

async function backupAuthFile() {
    const backupDir = path.join(dataDir, "restore-backups");
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const backupFile = path.join(backupDir, `auth-password-reset-${stamp}.json`);
    await writeFile(backupFile, await readFile(authFile, "utf8"), "utf8");
    return backupFile;
}

async function pruneBackups() {
    const backupDir = path.join(dataDir, "restore-backups");
    const entries = await readdir(backupDir, { withFileTypes: true });
    const backups = entries
        .filter((entry) => entry.isFile() && BACKUP_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));
    const removable = backups.slice(BACKUP_LIMIT);
    await Promise.all(removable.map((name) => unlink(path.join(backupDir, name))));
    return removable.length;
}

async function writeAuthDb(db) {
    const tempFile = `${authFile}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, "utf8");
    await rename(tempFile, authFile);
}

function hashPassword(password) {
    const salt = randomBytes(16).toString("base64url");
    const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("base64url");
    return `${HASH_ALGORITHM}$${ITERATIONS}$${salt}$${hash}`;
}

function listAdmins(db) {
    const admins = db.users.filter((user) => user?.role === "admin");
    if (!admins.length) {
        console.log("No admin users found.");
        return;
    }
    console.log("Admin users:");
    for (const user of admins) console.log(`- username=${user.username || "-"} email=${user.email || "-"} id=${user.id || "-"} status=${user.status || "-"} displayName=${user.displayName || "-"}`);
}

function printHelp() {
    console.log(`XSVO admin password reset

Usage:
  node scripts/reset-admin-password.mjs --username admin --password "NewPass123!"

Options:
  --username <name>       Select admin by username.
  --email <email>         Select admin by email.
  --id <userId>           Select admin by user id.
  --password <password>   New password, at least 8 characters.
  --data-dir <dir>        Data directory. Defaults to XSVO_DATA_DIR, VOZEB_DATA_DIR, or web/.data.
  --list-admins           List admin users without changing passwords.
  --help                  Show help.
`);
}

function fail(message) {
    console.error(message);
    console.error("Tip: node scripts/reset-admin-password.mjs --list-admins");
    process.exit(1);
}
