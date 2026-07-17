export const DEFAULT_CHANNEL_CONNECT_ERROR = "默认渠道连接失败：服务器无法访问模型接口，请检查后台 Base URL、服务器网络/DNS、HTTPS 证书或代理配置";

export function toSafeGenerationErrorMessage(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : "";
    if (isTimeoutError(error, message)) return "生成接口响应超时，请稍后重试或检查模型服务。";
    if (isFetchNetworkError(error, message)) return DEFAULT_CHANNEL_CONNECT_ERROR;
    return message || fallback;
}

function isTimeoutError(error: unknown, message: string) {
    const lower = message.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted due to timeout")) return true;
    if (!(error instanceof Error)) return false;
    return error.name === "TimeoutError";
}

function isFetchNetworkError(error: unknown, message: string) {
    if (message.toLowerCase() === "fetch failed") return true;
    if (!(error instanceof TypeError)) return false;
    const cause = "cause" in error ? error.cause : undefined;
    if (!cause || typeof cause !== "object") return false;
    const code = "code" in cause ? String(cause.code) : "";
    return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
}
