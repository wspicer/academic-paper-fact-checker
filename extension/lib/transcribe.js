// Speech-to-text with the user's own OpenAI key, sent directly to OpenAI.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI's upload limit

export async function transcribeWithOpenAI(blob, filename, key) {
  if (!key) throw new Error("Transcribing a video without captions needs an OpenAI key (set it in settings).");
  if (blob.size > MAX_AUDIO_BYTES)
    throw new Error(
      `That file is ${(blob.size / 1048576).toFixed(0)} MB; the limit for transcription is 25 MB. ` +
        "Try an audio-only version (e.g. .m4a or .mp3) or a shorter clip."
    );
  const form = new FormData();
  form.append("file", blob, filename || "audio.mp4");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
  } catch {
    throw new Error("Couldn't reach OpenAI for transcription.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Your OpenAI API key was rejected. Check it in settings.");
  if (!res.ok) throw new Error(`Transcription failed: ${data.error?.message || res.status}`);
  const segs = (data.segments || []).map((s) => ({ start: s.start, text: s.text }));
  if (!segs.length && data.text) segs.push({ start: 0, text: data.text });
  if (!segs.length) throw new Error("No speech was detected.");
  return segs;
}

// For HTML5 videos with a direct (non-streaming) file URL.
export async function fetchMedia(url) {
  const head = await fetch(url, { method: "HEAD" }).catch(() => null);
  const size = Number(head?.headers.get("content-length") || 0);
  if (size > MAX_AUDIO_BYTES)
    throw new Error(`This video file is ${(size / 1048576).toFixed(0)} MB, over the 25 MB transcription limit.`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the video (HTTP ${res.status}).`);
  return res.blob();
}
