export const editImageWithGemini = async (
  base64ImageData: string,
  mimeType: string,
  prompt: string,
  opts?: { width?: number; height?: number }
): Promise<string> => {
  try {
    const base = (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.VITE_API_BASE) || '';
    const url = base ? `${base.replace(/\/?$/, '')}/api/edit-image` : '/api/edit-image';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64ImageData, mimeType, prompt, width: opts?.width, height: opts?.height })
    });
    if (!res.ok) {
      const err = await res.json().catch(async () => {
        const text = await res.text().catch(() => '');
        return text ? { error: text } : {};
      });
      const details = typeof err?.details === 'string' ? err.details : JSON.stringify(err?.details || {});
      const msg = err?.error || `Request failed with ${res.status}`;
      throw new Error(details ? `${msg} – ${details}` : msg);
    }
    const data = await res.json();
    if (!data?.image) {
      throw new Error('Backend did not return an image');
    }
    return data.image as string;
  } catch (error) {
    console.error("Error calling backend:", error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to edit image with Gemini API.");
  }
};