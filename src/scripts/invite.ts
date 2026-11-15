export function inviteId(value: string, origin: string): string {
  const text = value.trim();
  if (!text) throw new Error('Paste the invite link shared by your host.');
  if (!/^(https?:\/\/|\/)/i.test(text)) throw new Error('That does not look like a link. Copy the full invite from your host.');
  let url: URL;
  try { url = new URL(text, origin); }
  catch { throw new Error('This link is incomplete or malformed. Copy the full invite again.'); }
  if (url.origin !== origin) throw new Error('This invite belongs to another site. Use a room link from this site.');
  const id = url.searchParams.get('id');
  if (!['/room', '/room/', '/room.html'].includes(url.pathname) || !id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('This room link is incomplete or malformed. Ask your host to copy the invite again.');
  }
  return id;
}
