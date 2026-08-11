/**
 * Audio transcription via OpenRouter's `openai/gpt-transcribe` model.
 *
 * Downloads audio from a URL, sends it to the transcription endpoint, and
 * returns the text. Used as a preprocessing step before the main LLM
 * generation — the transcribed text is injected into the message context.
 */

/**
 * Transcribe an audio file from a URL using `openai/gpt-transcribe`.
 *
 * @returns The transcribed text, or `null` on any failure.
 */
export async function transcribeAudio(audioUrl: string, apiKey: string): Promise<string | null> {
  // 1. Download the audio file
  let audioBlob: Blob;
  try {
    const audioResponse = await fetch(audioUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!audioResponse.ok) {
      console.log(
        JSON.stringify({ event: "transcribe_download_error", status: audioResponse.status }),
      );
      return null;
    }
    audioBlob = await audioResponse.blob();
  } catch (error) {
    console.log(JSON.stringify({ event: "transcribe_download_exception", error: String(error) }));
    return null;
  }

  // Skip files larger than 25MB (OpenAI limit)
  if (audioBlob.size > 25 * 1024 * 1024) {
    console.log(JSON.stringify({ event: "transcribe_too_large", size: audioBlob.size }));
    return null;
  }

  // 2. Send to OpenRouter transcription endpoint
  const formData = new FormData();
  formData.append("model", "openai/gpt-transcribe");
  formData.append("file", audioBlob, "voice-message.ogg");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      console.log(JSON.stringify({ event: "transcribe_api_error", status: response.status }));
      return null;
    }

    const data = (await response.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (error) {
    console.log(JSON.stringify({ event: "transcribe_api_exception", error: String(error) }));
    return null;
  }
}
