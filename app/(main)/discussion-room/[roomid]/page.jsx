"use client";
import { Button } from '../../../../components/ui/button';
import { api } from '../../../../convex/_generated/api';
import { CoachingExpert, CoachingOptions } from '../../../../services/options';
import { AIModel, CovertTextToSpeech } from '../../../../services/GlobalServices';
import ChatBox from './_components/ChatBox';
import Webcam from "react-webcam";
import { UserButton } from '@stackframe/stack';
import { useMutation, useQuery } from 'convex/react';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import React, { useRef, useState, useEffect } from 'react';
import RecordRTC from 'recordrtc';

// Utility to safely join message parts and clean duplicates
function cleanAndJoin(...parts) {
    const text = parts.filter(Boolean).join(' ');
    return text
        .replace(/\b(undefined|null|NaN)\b/gi, '')
        .replace(/undefined|null|NaN/gi, '')
        .split(' ')
        .filter((word, index, arr) => word !== '' && (index === 0 || word !== arr[index - 1]))
        .join(' ')
        .trim();
}

// Feedback handler: only remove headings/points, not all symbols, for ChatGPT-like output
function cleanFeedbackParagraph(text) {
  if (!text) return '';
  let cleaned = text
    .replace(/(Structured Notes|Summary|Feedback|Notes|Key Points|Takeaways|Conclusion|\b[A-Z][a-z]+:)/gi, '') // Remove headings
    .replace(/(^|\n|\r|\r\n)[\d]+[.)-]?\s+/g, ' ') // Remove numbered points at line starts
    .replace(/(^|\n|\r|\r\n)[•*-]\s+/g, ' ') // Remove bullet points
    .replace(/["'*`#]/g, '') // Remove unwanted symbols
    .replace(/\n+/g, ' ') // Remove newlines
    .replace(/\s{2,}/g, ' ') // Collapse spaces
    .replace(/\s*\n\s*/g, ' ') // Remove stray newlines
    .replace(/\s*\r\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}

function cleanAIReply(text) {
  if (!text) return '';
  return text
    .replace(/["'*`#]/g, '') // Remove unwanted symbols
    .replace(/\b(undefined|null|NaN)\b/gi, '')
    .replace(/undefined|null|NaN/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function DiscussionRoom() {
  const params = useParams();
  const roomid = params?.roomid;
  const audioPlayer = useRef(new Audio());

  // State hooks
  const [enableMic, setEnableMic] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [aiResponse, setAiResponse] = useState('');
  const [conversation, setConversation] = useState([]);
  const [loadingAI, setLoadingAI] = useState(false);
  const [isDetectingSilence, setIsDetectingSilence] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  // Remove pendingAI state since we'll handle AI responses directly
  
  const recorder = useRef(null);
  const mediaStreamRef = useRef(null);
  const silenceTimeoutRef = useRef(null);
  const UpdateConversation = useMutation(api.DiscussionRoom.UpdateConversation);

  const DiscussionRoomData = useQuery(
    api.DiscussionRoom.GetDiscussionRoom,
    roomid ? { id: roomid } : undefined
  );
  console.log("DiscussionRoomData:", DiscussionRoomData);

  const Expert = CoachingExpert.find((item) => item.name === DiscussionRoomData?.expertName);
  console.log("Expert:", Expert);
  const playAIResponse = async (text) => {
    if (!text || !Expert?.name) return;
    try {
      const ttsUrl = await CovertTextToSpeech(text, Expert.name);
      if (!ttsUrl || !audioPlayer.current) return;

      audioPlayer.current.src = ttsUrl;
      await audioPlayer.current.play();
      audioPlayer.current.onended = () => URL.revokeObjectURL(ttsUrl);
    } catch (err) {
      console.error('Error in text-to-speech:', err);
    }
  };

  const cleanTranscript = (text) =>
    (text || '')
      .replace(/["'*`#]/g, '')
      .replace(/\b(undefined|null|NaN)\b/gi, '')
      .replace(/undefined|null|NaN/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

  const stopMic = () => {
    setEnableMic(false);
    setIsRecording(false);
    setIsDetectingSilence(false);
    if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  };

  const processVoiceInput = async (blob) => {
    try {
      setLoadingAI(true);
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const data = await res.json();

      if (!res.ok) {
        setTranscript(data.error || 'Transcription failed.');
        setLoadingAI(false);
        return;
      }

      const cleanedTranscript = cleanTranscript(data.transcript);
      setTranscript(cleanedTranscript || 'No speech detected.');

      if (cleanedTranscript) {
        await handleSendMessage(cleanedTranscript);
      } else {
        setLoadingAI(false);
      }
    } catch (err) {
      setTranscript('Transcription error: ' + (err?.message || 'Unknown error'));
      setLoadingAI(false);
    }
  };

  // Initialize voices when the component mounts
  useEffect(() => {
    // This helps ensure voices are loaded
    if ('speechSynthesis' in window) {
      speechSynthesis.getVoices();
      // Chrome needs this event to load voices
      speechSynthesis.onvoiceschanged = () => {
        speechSynthesis.getVoices();
      };
    }
  }, []);

  // Add audio player cleanup
  useEffect(() => {
    return () => {
      if (audioPlayer.current) {
        audioPlayer.current.pause();
        audioPlayer.current.src = '';
      }
    };
  }, []);

  const connectToServer = async () => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

    setEnableMic(true);
    setTranscript('');
    setIsRecording(true);
    setIsDetectingSilence(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      recorder.current = new RecordRTC(stream, {
        type: 'audio',
        mimeType: 'audio/webm',
        numberOfAudioChannels: 1,
        desiredSampRate: 16000,
        timeSlice: 500,
        ondataavailable: () => {
          if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
          silenceTimeoutRef.current = setTimeout(() => {
            setIsDetectingSilence(false);
            disconnect();
          }, 5000);
        },
      });

      recorder.current.startRecording();
      silenceTimeoutRef.current = setTimeout(() => {
        setIsDetectingSilence(false);
        disconnect();
      }, 30000);
    } catch (err) {
      console.error(err);
      setTranscript('Microphone access denied or unavailable. Please allow mic access.');
      stopMic();
    }
  };

  const handleSendMessage = async (msg) => {
    try {
      setLoadingAI(true);
      const newUserMessage = { content: cleanAndJoin(msg), role: 'user' };

      let updatedConversation = [];
      setConversation((prev) => {
        updatedConversation = [...prev, newUserMessage];
        return updatedConversation;
      });

      if (roomid) {
        await UpdateConversation({
          id: roomid,
          conversation: updatedConversation,
        });
      }

      const response = await AIModel(
        DiscussionRoomData?.topic,
        DiscussionRoomData?.coachingOption,
        msg
      );

      if (!response?.error) {
        let aiMsg = response?.choices?.[0]?.message?.content || '';
        aiMsg = cleanAIReply(aiMsg);
        const newAIMessage = { content: aiMsg, role: 'assistant' };

        let finalConversation = [];
        setConversation((prev) => {
          finalConversation = [...prev, newAIMessage];
          return finalConversation;
        });

        if (roomid) {
          await UpdateConversation({
            id: roomid,
            conversation: finalConversation,
          });
        }

        await playAIResponse(aiMsg);
      }
    } catch (error) {
      console.error("Error in handleSendMessage:", error);
    } finally {
      setLoadingAI(false);
    }
  };

  // Effect to update Convex when conversation changes
  useEffect(() => {
    if (DiscussionRoomData?._id && conversation.length > 0) {
      // Debounce the update to avoid too many calls
      const timeoutId = setTimeout(() => {
        UpdateConversation({
          id: DiscussionRoomData._id,
          conversation: conversation
        });
      }, 1000);
      return () => clearTimeout(timeoutId);
    }
  }, [conversation, DiscussionRoomData?._id]);

  // Initialize conversation from DiscussionRoomData
  useEffect(() => {
    if (DiscussionRoomData?.conversation && conversation.length === 0) {
      setConversation(DiscussionRoomData.conversation);
    } else if (DiscussionRoomData && conversation.length === 0) {
      const welcomeMessage = {
        role: 'assistant',
        content: cleanAndJoin(`Hi! I'm ${DiscussionRoomData.expertName}, and I'll be your ${DiscussionRoomData.coachingOption} coach today. Let's discuss ${DiscussionRoomData.topic}. How can I help you?`)
      };
      setConversation([welcomeMessage]);
    }
  }, [DiscussionRoomData]);

  const disconnect = async (e) => {
    if (e) e.preventDefault();
    stopMic();

    if (!recorder.current) return;

    recorder.current.stopRecording(async () => {
      const blob = recorder.current.getBlob();
      recorder.current = null;

      if (!blob || blob.size === 0) {
        setTranscript('No audio recorded. Please check your microphone and try again.');
        return;
      }

      await processVoiceInput(blob);
    });
  };

  // Feedback handler
  const handleFeedback = async () => {
    setFeedbackLoading(true);
    setShowFeedback(true);
    try {
      const coachingOption = DiscussionRoomData?.coachingOption;
      const option = CoachingOptions.find(opt => opt.name === coachingOption);
      // Prompt for expert-level, topic-wise feedback in numbered format with no spelling mistakes
      const numberedPrompt = `You are an expert in this field. Analyze the conversation and for each main topic discussed, provide a short, clear, expert-level explanation in the following format:\n1. topic: (explanation)\n2. topic: (explanation)\nContinue numbering for each topic. Do not use bullet points, only numbers. Do not use any headings or extra formatting. Each topic should be on a new line. Avoid unwanted symbols. Ensure there are no spelling mistakes in your response. Example:\n1. promises: (content)\n2. loops: (content)`;
      const expertPrompt = option?.summeryPrompt || '';
      const prompt = `${numberedPrompt}\n\n${expertPrompt}\n\nConversation:\n${conversation.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join(' ')}`;
      const response = await AIModel(
        DiscussionRoomData?.topic,
        coachingOption,
        prompt
      );
      let feedbackText = response?.choices?.[0]?.message?.content || '';
      // Clean feedback but preserve numbered topic structure and ensure exactly one blank line between points
      feedbackText = feedbackText
        .replace(/\*|`|#|"|'/g, '') // Remove unwanted symbols
        .replace(/(\d+\.[^\n]*)/g, '\n$1') // Ensure each numbered point starts on a new line
        .replace(/\n{2,}/g, '\n') // Collapse multiple newlines
        .replace(/\n(\d+\.)/g, '\n\n$1') // Add blank line before each numbered point
        .replace(/^\n+/, '') // Remove leading newlines
        .replace(/\n{3,}/g, '\n\n') // Collapse 3+ newlines to exactly 2
        .replace(/\s{2,}/g, ' ') // Collapse spaces
        .trim();
      setFeedback(feedbackText);
    } catch (err) {
      setFeedback('Failed to generate feedback.');
    } finally {
      setFeedbackLoading(false);
    }
  };

  return (
    <div className='-mt-6 sm:-mt-12'>
      {(!roomid || !DiscussionRoomData) ? (
        <div>Loading...</div>
      ) : (
        <>
          <h2 className='text-xl sm:text-2xl font-bold text-gray-800 text-center sm:text-left'>
            {DiscussionRoomData?.coachingOption}
          </h2>
          <div className='mt-4 sm:mt-5 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-10'>
            {/* Video/Expert Section (2 columns) */}
            <div className='lg:col-span-2 flex flex-col h-auto min-h-[320px] sm:h-[60vh]'>
              <div className='flex-1 bg-secondary border rounded-2xl sm:rounded-4xl flex flex-col items-center justify-center relative p-4 sm:p-0'>
                <Image 
                  src={Expert?.avatar} 
                  alt='Avatar' 
                  width={80} 
                  height={80} 
                  className={`h-[64px] w-[64px] sm:h-[80px] sm:w-[80px] rounded-full object-cover${enableMic ? ' animate-pulse' : ''}`} 
                />
                <h2 className='text-gray-500 text-base sm:text-lg'>{Expert?.name}</h2>
                <div className='absolute bottom-3 right-3 sm:bottom-5 sm:right-10'>
                  <Webcam height={60} width={100} className='rounded-xl sm:rounded-2xl bg-gray-300' />
                </div>
              </div>             
                 <div className='mt-3 sm:mt-5 flex flex-col items-center justify-center w-full'>
                  <div className="mb-2 text-xs sm:text-sm text-gray-600 text-center max-w-xs">
                    {!enableMic ? (
                      <>Click <b>Connect</b> to start a voice conversation with the AI. After connecting, speak your question or topic, and when finished, click <b>Disconnect</b> to stop recording and get your AI response.</>
                    ) : (
                      <>You are now connected. Speak your question or topic, then click <b>Disconnect</b> when you are done speaking to get your AI response.</>
                    )}
                  </div>
                  {!enableMic ? (
                    <Button onClick={connectToServer} disabled={isRecording || loadingAI} className="w-full sm:w-auto">Connect</Button>
                  ) : (
                    <Button variant="destructive" onClick={disconnect} disabled={!isRecording} className="w-full sm:w-auto">Disconnect</Button>
                  )}
                  {transcript && (
                    <p className="mt-2 text-xs text-gray-500 text-center max-w-md">{transcript}</p>
                  )}
                </div>
            </div>
            {/* ChatBox Section (1 column) */}
            <div className='h-[40vh] sm:h-[60vh] bg-gray-50 rounded-lg shadow-lg flex flex-col w-full'>              
               <ChatBox 
                conversation={conversation} 
                loadingAI={loadingAI} 
                aiName={Expert?.name || 'AI'} 
                userName={'You'}
                userAvatar={'/mypic.jpeg'}
                aiAvatar={Expert?.avatar || '/ai-avatar.png'}
                topic={DiscussionRoomData?.topic}
                conversationEnded={!enableMic && !isRecording && !loadingAI}
              />
              {/* Feedback section for mobile: show below chatbox */}
              <div className="block lg:hidden w-full mt-4">
                <div className='flex justify-end items-center'>
                  <Button className="bg-gray-700 w-full sm:w-auto" onClick={handleFeedback} disabled={feedbackLoading}>
                    {feedbackLoading ? 'Generating...' : 'Feedback Generation'}
                  </Button>
                </div>
                {showFeedback && feedback && (
                  <div className="mt-4 p-4 bg-gray-100 rounded-lg shadow text-gray-800">
                    <div>{feedback}</div>
                    <Button className="mt-2 w-full sm:w-auto" variant="outline" onClick={() => setShowFeedback(false)}>Close</Button>
                  </div>
                )}
              </div>
            </div>
            {/* Feedback section for desktop: show to the side */}
            <div className='hidden lg:block w-full lg:w-[61vw] mt-4 lg:mt-0'>
              <div className='flex justify-end items-center'>
                <Button className="bg-gray-700 w-full sm:w-auto" onClick={handleFeedback} disabled={feedbackLoading}>
                  {feedbackLoading ? 'Generating...' : 'Feedback Generation'}
                </Button>
              </div>
              {showFeedback && feedback && (
                <div className="mt-4 p-4 bg-gray-100 rounded-lg shadow text-gray-800">
                  <div>{feedback}</div>
                  <Button className="mt-2 w-full sm:w-auto" variant="outline" onClick={() => setShowFeedback(false)}>Close</Button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default DiscussionRoom


