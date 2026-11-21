"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  X,
  Send,
  Loader2,
  BookOpen,
  ArrowRight,
  LifeBuoy
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";

interface Message {
  id: string;
  sender: "customer" | "ai_bot" | "system";
  text: string;
  sources?: Array<{ id: string; title: string; category: string }>;
  suggestEscalation?: boolean;
}

export default function ChatWidget({ embedded = false }: { embedded?: boolean }) {
  const [isOpen, setIsOpen] = useState(embedded);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "intro-1",
      sender: "ai_bot",
      text: "Hello! I am BizAssist AI, your intelligent customer support assistant.\n\nI can assist you with your account, billing, API integrations, ticket tracking, and platform documentation. How can I help you today?",
    }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [escalatedTicket, setEscalatedTicket] = useState<{ id: string; ticket_number: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const defaultQuestions = [
    "How do I reset password & 2FA?",
    "What are API rate limits & 429?",
    "How to request duplicate invoice refund?",
    "Hardware security key delivery status"
  ];

  const handleSend = async (messageText?: string) => {
    const textToSend = messageText || input;
    if (!textToSend.trim() || loading) return;

    const userMsg: Message = {
      id: "usr-" + Date.now(),
      sender: "customer",
      text: textToSend.trim(),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!messageText) setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message: textToSend.trim()
        })
      });

      const data = await res.json();
      if (data.session_id) setSessionId(data.session_id);

      const botMsg: Message = {
        id: "bot-" + Date.now(),
        sender: "ai_bot",
        text: data.answer || "No verified documentation found matching your query.",
        sources: data.sources || [],
        suggestEscalation: data.suggestEscalation
      };

      setMessages((prev) => [...prev, botMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: "err-" + Date.now(),
          sender: "system",
          text: "ERROR: Communication timeout with AI inference cluster. Please open a manual support ticket."
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleEscalate = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          action: "escalate",
          message: "Escalated to human support"
        })
      });

      const data = await res.json();
      if (data.escalated) {
        setEscalatedTicket({ id: data.ticket_id, ticket_number: data.ticket_number });
        setMessages((prev) => [
          ...prev,
          {
            id: "esc-" + Date.now(),
            sender: "system",
            text: data.message
          }
        ]);
      }
    } finally {
      setLoading(false);
    }
  };

  const containerClasses = embedded
    ? "w-full max-w-4xl mx-auto h-[650px] bg-brand-white border-2 border-brand-black shadow-hard flex flex-col font-mono"
    : "fixed bottom-5 right-5 z-50 w-96 sm:w-[440px] h-[580px] bg-brand-white border-2 border-brand-black shadow-hard flex flex-col font-mono";

  if (!embedded && !isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-5 right-5 z-50 flex items-center space-x-2 px-4 py-3 bg-brand-primary text-brand-white border-2 border-brand-black shadow-hard font-mono font-bold text-xs uppercase tracking-wider hover:bg-brand-black hover:text-brand-accent transition group"
      >
        <span className="w-2.5 h-2.5 bg-brand-accent border border-brand-black animate-pulse" />
        <span>[AI SUPPORT BOT]</span>
      </button>
    );
  }

  return (
    <div className={containerClasses}>
      {/* Header */}
      <div className="bg-brand-black text-brand-white p-3.5 flex items-center justify-between border-b-2 border-brand-primary">
        <div className="flex items-center space-x-2.5">
          <Image src="/logo.png" alt="BizAssist AI" width={90} height={22} className="h-6 w-auto object-contain brightness-0 invert" />
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-heading text-lg font-bold tracking-wider text-brand-white uppercase leading-none">
                AI KNOWLEDGE CHATBOT
              </span>
              <span className="px-1.5 py-0.2 bg-brand-primary text-brand-accent text-[9px] font-bold border border-brand-accent">
                RAG ACTIVE
              </span>
            </div>
            <p className="text-[10px] text-brand-offwhite/60 uppercase">GROUNDED SUPPORT // TEAM 3</p>
          </div>
        </div>
        {!embedded && (
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 text-brand-offwhite hover:text-brand-pink transition"
            aria-label="Close chat"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Escalation alert banner */}
      {escalatedTicket && (
        <div className="bg-brand-accent text-brand-black px-3 py-2 border-b-2 border-brand-black flex items-center justify-between text-xs font-bold uppercase">
          <span>ESCALATED &gt;&gt; TICKET {escalatedTicket.ticket_number}</span>
          <Link
            href={`/customer/tickets/${escalatedTicket.id}`}
            className="underline hover:text-brand-pink flex items-center"
          >
            VIEW <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </Link>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 p-4 overflow-y-auto space-y-3.5 bg-brand-offwhite text-xs">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.sender === "customer" ? "items-end" : "items-start"}`}
          >
            <span className="text-[10px] uppercase font-bold text-brand-black/60 mb-1">
              {m.sender === "customer" ? "// YOU" : m.sender === "system" ? "// SYSTEM" : "// BIZASSIST_AI"}
            </span>
            <div
              className={`max-w-[88%] p-3 border-2 border-brand-black ${
                m.sender === "customer"
                  ? "bg-brand-primary text-brand-white shadow-hard-green"
                  : m.sender === "system"
                  ? "bg-brand-accent text-brand-black shadow-hard-yellow font-bold"
                  : "bg-brand-white text-brand-black shadow-hard"
              }`}
            >
              <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>

              {/* Source citations from KB */}
              {m.sources && m.sources.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-brand-black/20 text-[10px]">
                  <p className="font-bold uppercase tracking-wider text-brand-primary flex items-center">
                    <BookOpen className="w-3 h-3 mr-1 text-brand-primary" />
                    VERIFIED DOCUMENTATION SOURCES:
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.sources.map((s) => (
                      <span
                        key={s.id}
                        className="bg-brand-offwhite border border-brand-black px-1.5 py-0.5 text-brand-black font-bold uppercase"
                      >
                        [{s.title}]
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Escalation button */}
              {(m.suggestEscalation || m.sender === "ai_bot") && !escalatedTicket && (
                <div className="mt-2.5 pt-2 border-t border-brand-black/20 flex items-center justify-between">
                  <span className="text-[10px] text-brand-black/60 uppercase">Require engineer review?</span>
                  <button
                    onClick={handleEscalate}
                    disabled={loading}
                    className="inline-flex items-center text-[10px] font-bold text-brand-pink hover:text-brand-black uppercase bg-brand-offwhite border border-brand-pink px-2 py-0.5 hover:bg-brand-pink hover:text-brand-white transition"
                  >
                    <LifeBuoy className="w-3 h-3 mr-1" />
                    ESCALATE TICKET &gt;&gt;
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-center space-x-2 text-brand-primary font-bold text-xs p-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>AI QUERY IN PROGRESS [SEARCHING KB]...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggested FAQs */}
      <div className="px-3 py-2 bg-brand-white border-t border-brand-black text-[10px]">
        <span className="font-bold uppercase text-brand-black/60 block mb-1">
          SUGGESTED INQUIRIES:
        </span>
        <div className="flex flex-wrap gap-1.5">
          {defaultQuestions.map((q) => (
            <button
              key={q}
              onClick={() => handleSend(q)}
              disabled={loading}
              className="bg-brand-offwhite hover:bg-brand-accent hover:text-brand-black text-brand-black border border-brand-black px-2 py-0.5 uppercase transition font-bold"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="p-2.5 bg-brand-white border-t-2 border-brand-black flex items-center space-x-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ENTER QUERY (E.G. HOW TO CONFIGURE SSO)..."
          disabled={loading}
          className="flex-1 bg-brand-offwhite text-brand-black text-xs px-3 py-2 border border-brand-black focus:outline-hidden focus:bg-brand-white uppercase"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-3 py-2 bg-brand-primary text-brand-white border border-brand-black font-bold uppercase text-xs hover:bg-brand-accent hover:text-brand-black transition disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>
    </div>
  );
}
