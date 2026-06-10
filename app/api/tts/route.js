import { NextResponse } from "next/server";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

function getAwsCredentials() {
  const accessKeyId =
    process.env.AWS_ACCESS_KEY_ID || process.env.NEXT_PUBLIC_AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.AWS_SECRET_ACCESS_KEY || process.env.NEXT_PUBLIC_AWS_SECRET_KEY;

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return { accessKeyId, secretAccessKey };
}

async function synthesizeSpeech(pollyClient, text, voiceId, engine) {
  const command = new SynthesizeSpeechCommand({
    Text: text,
    OutputFormat: "mp3",
    Engine: engine,
    VoiceId: voiceId,
    LanguageCode: "en-US",
  });
  return pollyClient.send(command);
}

export async function POST(req) {
  try {
    const { text, voiceId } = await req.json();
    if (!text || !voiceId) {
      return NextResponse.json({ error: "Missing text or voiceId" }, { status: 400 });
    }

    const credentials = getAwsCredentials();
    if (!credentials) {
      return NextResponse.json(
        {
          error:
            "AWS credentials are not configured. Add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to .env.local",
        },
        { status: 500 }
      );
    }

    const pollyClient = new PollyClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials,
    });

    let audioStream;
    try {
      ({ AudioStream: audioStream } = await synthesizeSpeech(
        pollyClient,
        text,
        voiceId,
        "neural"
      ));
    } catch (neuralErr) {
      try {
        ({ AudioStream: audioStream } = await synthesizeSpeech(
          pollyClient,
          text,
          voiceId,
          "standard"
        ));
      } catch (standardErr) {
        return NextResponse.json(
          { error: `Polly error: ${standardErr.message || neuralErr.message}` },
          { status: 500 }
        );
      }
    }

    const buffer = Buffer.from(await audioStream.transformToByteArray());
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "inline; filename=tts.mp3",
      },
    });
  } catch (err) {
    console.error("Polly TTS error:", err);
    return NextResponse.json({ error: err.message || "TTS server error" }, { status: 500 });
  }
}
