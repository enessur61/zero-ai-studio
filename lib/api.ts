export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `HTTP Fehler ${res.status}`);
  }
  return data as T;
}
