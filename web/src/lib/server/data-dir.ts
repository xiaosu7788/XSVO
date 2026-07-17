import { basename, dirname, resolve } from "node:path";

export function getServerDataDir() {
    const configuredDir = process.env.XSVO_DATA_DIR?.trim() || process.env.VOZEB_DATA_DIR?.trim();
    if (configuredDir) return resolve(configuredDir);

    const cwd = process.cwd();
    if (basename(cwd) === "standalone" && basename(dirname(cwd)) === ".next") {
        return resolve(cwd, "..", "..", ".data");
    }
    return resolve(cwd, ".data");
}

export function resolveServerDataPath(fileName: string) {
    return resolve(getServerDataDir(), fileName);
}
