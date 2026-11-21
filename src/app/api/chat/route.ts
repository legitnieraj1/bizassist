import { NextResponse } from "next/server";
import getSupabaseAdmin from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { queryKnowledgeBaseChatbot } from "@/lib/ai-service";

export async function POST(request: Request) {
  try {
    const { session_id, message, action } = await request.json();
    const currentUser = await getCurrentUser();
    const db = getSupabaseAdmin();
    const now = new Date().toISOString();

    let sessionId = session_id;

    // Create session if not provided
    if (!sessionId) {
      sessionId = "chat-" + Math.random().toString(36).substring(2, 9);
      // Fire-and-forget session creation so it doesn't block response
      db.from("chat_sessions").insert({
        id: sessionId,
        customer_id: currentUser?.id || null,
        customer_name: currentUser?.full_name || "Guest Customer",
        status: "active",
        created_at: now
      }).then(() => {});
    }

    // Action: Escalate chat to ticket
    if (action === "escalate") {
      const { data: chatMessages } = await db
        .from("chat_messages")
        .select("sender_type, message")
        .eq("session_id", sessionId)
        .order("created_at");

      const transcript = ((chatMessages || []) as { sender_type: string; message: string }[])
        .map(m => `[${m.sender_type.toUpperCase()}]: ${m.message}`)
        .join("\n");

      const customerId = currentUser?.id || "usr-cust-1";

      const { count } = await db.from("tickets").select("*", { count: "exact", head: true });
      const ticketNumber = `BIZ-${1000 + (count || 0) + 1}`;
      const ticketId = "tkt-" + Math.random().toString(36).substring(2, 9);

      const subject = `Escalated Chat Support Request (${ticketNumber})`;
      const description = `This ticket was escalated from an AI Support Chat session.\n\nConversation Transcript:\n${transcript}\n\nLast Customer Message: ${message || "Customer requested human support assistance."}`;

      await db.from("tickets").insert({
        id: ticketId,
        ticket_number: ticketNumber,
        customer_id: customerId,
        assigned_agent_id: null,
        subject,
        description,
        category: "General Enquiries",
        priority: "High",
        sentiment: "Urgent",
        ai_summary: "Customer escalated chat session requesting human support.",
        ai_suggested_response: "Hello,\n\nWe have received your escalated request from our AI chatbot assistant. A support agent is reviewing your chat transcript and will follow up shortly.",
        status: "Open",
        contact_email: currentUser?.email || "customer@example.com",
        created_at: now,
        updated_at: now
      });

      // Link session to ticket & record system message
      db.from("chat_sessions")
        .update({ status: "escalated", escalated_ticket_id: ticketId })
        .eq("id", sessionId)
        .then(() => {});

      db.from("chat_messages").insert({
        id: "cmsg-" + Math.random().toString(36).substring(2, 9),
        session_id: sessionId,
        sender_type: "system",
        message: `Ticket ${ticketNumber} has been successfully opened for human agent follow-up. You can track this in your Tickets portal.`,
        created_at: now
      }).then(() => {});

      return NextResponse.json({
        success: true,
        escalated: true,
        ticket_id: ticketId,
        ticket_number: ticketNumber,
        message: `Your issue has been escalated to human support under Ticket #${ticketNumber}. Our team has received your chat transcript and will respond shortly.`
      });
    }

    if (!message || message.trim().length === 0) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    // 1. Asynchronously log the customer's incoming message without blocking the AI query
    db.from("chat_messages").insert({
      id: "cmsg-" + Math.random().toString(36).substring(2, 9),
      session_id: sessionId,
      sender_type: "customer",
      message: message.trim(),
      created_at: now
    }).then(() => {});

    // 2. Fetch recent conversation history quickly for context (limited to 4 messages)
    let history: Array<{ role: "user" | "bot"; text: string }> = [];
    try {
      const { data: historyRows } = await db
        .from("chat_messages")
        .select("sender_type, message")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(4);

      if (historyRows && historyRows.length > 0) {
        history = (historyRows as any[]).reverse().map((r: any) => ({
          role: r.sender_type === "customer" ? ("user" as const) : ("bot" as const),
          text: r.message
        }));
      }
    } catch {
      // Continue without history if DB is slow
    }

    // 3. AI Knowledge-based retrieval & answer powered by fast multi-agent Gemini
    const botResult = await queryKnowledgeBaseChatbot(message, history);

    // 4. Save bot reply asynchronously in background
    const botMsgId = "cmsg-" + Math.random().toString(36).substring(2, 9);
    db.from("chat_messages").insert({
      id: botMsgId,
      session_id: sessionId,
      sender_type: "ai_bot",
      message: botResult.answer,
      sources_json: JSON.stringify(botResult.sources),
      created_at: new Date().toISOString()
    }).then(() => {});

    // 5. Return response immediately!
    return NextResponse.json({
      session_id: sessionId,
      answer: botResult.answer,
      sources: botResult.sources,
      suggestEscalation: botResult.suggestEscalation,
      suggestedFollowUps: botResult.suggestedFollowUps
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
