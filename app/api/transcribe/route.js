import { NextResponse } from "next/server";

const ASSEMBLY_API_KEY = process.env.ASSEMBLY_API_KEY;

export async function POST(req) {
  try {
    if (!ASSEMBLY_API_KEY) {
      return NextResponse.json(
        { error: "ASSEMBLY_API_KEY is not configured in .env.local" },
        { status: 500 }
      );
    }

    const buffer = await req.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      return NextResponse.json({ error: "No audio data received" }, { status: 400 });
    }

    const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        authorization: ASSEMBLY_API_KEY,
        "content-type": "application/octet-stream",
      },
      body: Buffer.from(buffer),
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || !uploadData.upload_url) {
      return NextResponse.json(
        { error: uploadData.error || "Failed to upload audio to AssemblyAI" },
        { status: uploadRes.status || 500 }
      );
    }

    const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        authorization: ASSEMBLY_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audio_url: uploadData.upload_url }),
    });

    const transcriptData = await transcriptRes.json();
    if (!transcriptRes.ok || !transcriptData.id) {
      return NextResponse.json(
        { error: transcriptData.error || "Transcription request failed" },
        { status: transcriptRes.status || 500 }
      );
    }

    let transcriptText = "";
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((res) => setTimeout(res, 2000));

      const pollRes = await fetch(
        `https://api.assemblyai.com/v2/transcript/${transcriptData.id}`,
        { headers: { authorization: ASSEMBLY_API_KEY } }
      );
      const pollData = await pollRes.json();

      if (pollData.status === "completed") {
        transcriptText = pollData.text || "";
        break;
      }
      if (pollData.status === "failed") {
        return NextResponse.json(
          { error: pollData.error || "Transcription failed" },
          { status: 500 }
        );
      }
    }

    if (!transcriptText) {
      return NextResponse.json(
        { error: "Transcription timed out. Please try again." },
        { status: 504 }
      );
    }

    return NextResponse.json({ transcript: transcriptText });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Server error" }, { status: 500 });
  }
}
