export async function post(path: string, data: unknown) {
  let response: Response;
  let result;
  try {
    response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(10000) });
    result = await response.json();
  } catch {
    throw new Error('Cannot reach the room service. Check your connection and try again.');
  }
  if (!response.ok) throw Object.assign(new Error(result.message || 'Request failed. Please try again.'), { status: response.status, teamName: result.teamName });
  return result;
}
