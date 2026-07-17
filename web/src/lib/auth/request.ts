import { AuthInputError } from "./store";

export async function readJsonBody<T>(request: Request) {
    try {
        return (await request.json()) as T;
    } catch {
        throw new AuthInputError("请求内容不是有效 JSON");
    }
}
