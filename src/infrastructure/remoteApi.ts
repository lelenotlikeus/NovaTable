const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");
const TOKEN_KEY = "novatable.remote-token.v1";

export const remoteApiEnabled = Boolean(API_URL);

export function storeRemoteToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearRemoteToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function remoteApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error("NovaTable online services are not configured.");
  const token = localStorage.getItem(TOKEN_KEY);
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error || `NovaTable service error (${response.status}).`);
  return result as T;
}
