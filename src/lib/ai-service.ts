import getSupabaseAdmin from "./supabase";
import { TICKET_CATEGORIES } from "./constants";

export { TICKET_CATEGORIES };

export interface AIClassificationResult {
  category: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  sentiment: "Frustrated" | "Angry" | "Urgent" | "Confused" | "Neutral" | "Satisfied";
  summary: string;
  suggested_response: string;
}

export interface ChatbotResponse {
  answer: string;
  sources: Array<{ id: string; title: string; category: string }>;
  suggestEscalation: boolean;
  suggestedFollowUps: string[];
}

// In-memory cache for Knowledge Base articles to prevent repetitive DB queries
let cachedArticles: Array<{ id: string; title: string; content: string; category: string; tags: string }> | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fallback verified Knowledge Base articles for grounding
const DEFAULT_KB_ARTICLES = [
  {
    id: "kb-1",
    title: "How to Reset Your Account Password and Enable 2FA",
    category: "Account Issues",
    tags: "password,login,2fa,security,auth",
    content: "To reset your password, visit the login page and click 'Forgot Password'. You will receive a secure token via email valid for 30 minutes. Once logged in, go to Settings > Security to enable Multi-Factor Authentication (MFA/2FA) using Google Authenticator, Authy, or SMS codes."
  },
  {
    id: "kb-2",
    title: "Understanding Invoices, Billing Cycles, and Payment Methods",
    category: "Billing & Payments",
    tags: "billing,invoices,refund,payment,credit card",
    content: "BizAssist AI invoices are generated on the 1st of every calendar month. We accept Visa, Mastercard, American Express, and corporate ACH transfers. You can download PDF VAT invoices anytime under Admin > Billing & Invoices. If a charge fails, we retry automatically over 3 consecutive business days before pausing premium features."
  },
  {
    id: "kb-3",
    title: "API Rate Limits, Webhook Endpoints, and 429 Errors",
    category: "Technical Support",
    tags: "api,developer,rate limit,429,webhooks,rest",
    content: "Standard tier API keys allow 60 requests per minute with burst capacity of 100 req/min. Enterprise keys support 600 req/min. If you receive HTTP 429 Too Many Requests, implement exponential backoff using the 'Retry-After' header. Webhooks must return HTTP 200 within 5000ms to avoid re-delivery retries."
  },
  {
    id: "kb-4",
    title: "Order Tracking, Shipment Delays, and Courier Updates",
    category: "Orders & Delivery",
    tags: "tracking,shipping,order,delivery,courier",
    content: "Track physical hardware keys and enterprise token shipments via the Logistics portal using your BIZ-ORD tracking number. Delivery typically takes 2-4 business days for domestic shipments and 5-8 business days for international orders. In case of unexpected courier delays, contact support immediately for priority expedited dispatch."
  },
  {
    id: "kb-5",
    title: "Refund Eligibility, Money-Back Guarantees, and Credit Memos",
    category: "Billing & Payments",
    tags: "refund,money-back,cancel,downgrade,credit",
    content: "BizAssist AI provides a 14-day full refund guarantee for new monthly subscriptions if you are unsatisfied. Annual plans are eligible for pro-rated credit memos within 30 days of renewal. To initiate a refund, submit a ticket under 'Billing & Payments' with your invoice number."
  },
  {
    id: "kb-6",
    title: "Single Sign-On (SSO) SAML and Okta Integration Setup",
    category: "Technical Support",
    tags: "sso,saml,okta,azure,directory,enterprise",
    content: "Administrators can configure SAML 2.0 or OIDC single sign-on through Okta, Azure AD, or Google Workspace. Navigate to Settings > Identity Provider, download the metadata XML, and assign user group roles to automatically map Customer, Agent, or Admin privileges upon directory synchronization."
  }
];

/**
 * Ultra-Fast Concurrent Gemini API Dispatcher
 * Races the fastest lightweight models concurrently with an aggressive timeout
 */
async function callFastGemini(
  apiKey: string,
  prompt: string,
  options?: {
    systemInstruction?: string;
    jsonResponse?: boolean;
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
  }
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? 4500; // 4.5s budget
  const fastModels = ["gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

  const fetchSingleModel = async (model: string): Promise<string> => {
    const payload: any = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options?.temperature ?? 0.2,
        maxOutputTokens: options?.maxOutputTokens ?? 350
      }
    };

    if (options?.systemInstruction) {
      payload.systemInstruction = {
        parts: [{ text: options.systemInstruction }]
      };
    }

    if (options?.jsonResponse) {
      payload.generationConfig.responseMimeType = "application/json";
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );

    if (!res.ok) {
      throw new Error(`Model ${model} responded with ${res.status}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`Model ${model} returned empty response`);
    return text.trim();
  };

  try {
    // Race all fast models simultaneously — first to respond wins
    return await Promise.any(fastModels.map(m => fetchSingleModel(m)));
  } catch {
    return null;
  }
}

/**
 * Main AI Ticket Classifier & Analyzer
 */
export async function analyzeTicketWithAI(
  subject: string,
  description: string,
  customerCategory?: string
): Promise<AIClassificationResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const prompt = `Analyze this customer support ticket for the BizAssist AI SaaS platform and produce a strictly valid JSON response.
Subject: "${subject}"
Description: "${description}"
Customer Selected Category: "${customerCategory || "None"}"

Respond ONLY with a JSON object matching this schema:
{
  "category": "Technical Support" | "Billing & Payments" | "Account Issues" | "Orders & Delivery" | "Product Issues" | "General Enquiries" | "Other",
  "priority": "Critical" | "High" | "Medium" | "Low",
  "sentiment": "Frustrated" | "Angry" | "Urgent" | "Confused" | "Neutral" | "Satisfied",
  "summary": "Short 1-2 sentence summary of core complaint and impact",
  "suggested_response": "Empathetic, professional suggested first response for a human support agent"
}`;

      const raw = await callFastGemini(apiKey, prompt, { jsonResponse: true, temperature: 0.1, timeoutMs: 4000 });
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.category && parsed.priority && parsed.sentiment) {
          return parsed as AIClassificationResult;
        }
      }
    } catch {
      // Fallback below
    }
  }

  return semanticAnalyzeTicket(subject, description, customerCategory);
}

/**
 * Intelligent Semantic / Heuristic Engine
 */
function semanticAnalyzeTicket(
  subject: string,
  description: string,
  customerCategory?: string
): AIClassificationResult {
  const text = `${subject} ${description}`.toLowerCase();

  let category: string = customerCategory || "General Enquiries";

  const isTechnical = /api|webhook|500|429|bug|error|crash|timeout|latency|sdk|stack trace|code|database|server|endpoint/i.test(text);
  const isBilling = /bill|invoice|charge|refund|credit|payment|amex|visa|card|overcharged|subscription|pricing|receipt/i.test(text);
  const isAccount = /login|logout|password|reset|2fa|mfa|locked|account|access|permission|sso|saml|email change/i.test(text);
  const isOrders = /order|shipping|courier|delivery|fedex|ups|tracking|shipment|hardware|package|arrive/i.test(text);
  const isProduct = /feature|ui|dashboard|export|button|slow|display|mobile app|integration|settings/i.test(text);

  if (isBilling) category = "Billing & Payments";
  else if (isAccount) category = "Account Issues";
  else if (isTechnical) category = "Technical Support";
  else if (isOrders) category = "Orders & Delivery";
  else if (isProduct) category = "Product Issues";

  let priority: "Critical" | "High" | "Medium" | "Low" = "Medium";

  const criticalSignals = ["down", "outage", "security", "breach", "payroll", "halt", "all users", "emergency", "lost revenue", "cannot access", "locked out completely", "data loss", "urgent", "production", "blocked"];
  const highSignals = ["broken", "double bill", "refund immediately", "timeout", "intermittent", "500 error", "cannot work", "deadline", "fail", "unable to", "blocking"];
  const lowSignals = ["how to", "inquiry", "question", "curious", "documentation", "guide", "minor", "typo"];

  const hasCritical = criticalSignals.some(w => text.includes(w));
  const hasHigh = highSignals.some(w => text.includes(w));
  const hasLow = lowSignals.some(w => text.includes(w));

  if (hasCritical && (category === "Account Issues" || category === "Technical Support" || category === "Billing & Payments")) {
    priority = "Critical";
  } else if (hasHigh || hasCritical) {
    priority = "High";
  } else if (hasLow) {
    priority = "Low";
  } else {
    priority = "Medium";
  }

  let sentiment: AIClassificationResult["sentiment"] = "Neutral";
  if (/furious|angry|ridiculous|unacceptable|lawyer|threaten|worst|scam|terrible/i.test(text)) {
    sentiment = "Angry";
  } else if (/frustrated|stuck|tried multiple times|since yesterday|still not working|disappointed|error again/i.test(text)) {
    sentiment = "Frustrated";
  } else if (/urgent|asap|emergency|immediately|critical|deadline|time sensitive/i.test(text)) {
    sentiment = "Urgent";
  } else if (/confused|unclear|why|where is|don't understand|haven't received/i.test(text)) {
    sentiment = "Confused";
  } else if (/thank|great|love|appreciate|helpful/i.test(text)) {
    sentiment = "Satisfied";
  }

  let summary = "";
  if (category === "Account Issues") {
    summary = `Customer is experiencing an authentication failure (${subject.slice(0, 60)}). Immediate access to account services is hindered.`;
  } else if (category === "Billing & Payments") {
    summary = `Customer reports a financial transaction dispute regarding ${subject.slice(0, 60)}. Requires invoice verification or refund processing.`;
  } else if (category === "Technical Support") {
    summary = `Technical disruption reported regarding ${subject.slice(0, 60)}. Telemetry inspection and endpoint diagnostics needed.`;
  } else if (category === "Orders & Delivery") {
    summary = `Inquiry regarding fulfillment logistics and shipment status for ${subject.slice(0, 60)}.`;
  } else {
    summary = `Customer inquiry regarding ${subject.slice(0, 60)}. Requires support review and contextual guidance.`;
  }

  let suggested_response = "";
  if (category === "Account Issues") {
    suggested_response = `Dear Customer,\n\nThank you for reaching out to BizAssist Support. We understand how critical it is to regain secure access to your account.\n\nWe have initiated an internal session audit and cleared any conflicting authentication locks. Please try resetting your session via the password reset portal, and feel free to reply directly to this ticket if the issue persists so we can issue a direct one-time access token.\n\nBest regards,\nBizAssist AI Support Team`;
  } else if (category === "Billing & Payments") {
    suggested_response = `Hello,\n\nThank you for bringing this billing matter to our attention. We take billing accuracy very seriously.\n\nOur finance team has been notified to inspect the charge history against your account records. If a duplicate transaction or incorrect tier charge occurred, we will issue a direct refund to your original payment method within 1-3 business days.\n\nSincerely,\nBizAssist Billing Team`;
  } else if (category === "Technical Support") {
    suggested_response = `Hello,\n\nThank you for the detailed error report. We are actively reviewing our system health dashboards and endpoint logs for the timeframe specified.\n\nTo help us isolate the issue faster, could you confirm if this occurs across all team members or specific IP locations? We will follow up shortly with a technical update.\n\nBest regards,\nBizAssist Technical Operations`;
  } else {
    suggested_response = `Hi,\n\nThank you for contacting BizAssist Support. We have received your request regarding "${subject}".\n\nOur team is reviewing the details provided and will get back to you with a comprehensive solution shortly. In the meantime, please let us know if there is any additional information you would like to share.\n\nWarm regards,\nBizAssist Support Team`;
  }

  return { category, priority, sentiment, summary, suggested_response };
}

/**
 * Regenerate Response with Specific Tone
 */
export async function regenerateAIResponse(
  subject: string,
  description: string,
  tone: "Empathetic" | "Direct & Technical" | "Concise" | "Step-by-Step",
  summary?: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const prompt = `You are an expert customer support agent for BizAssist AI SaaS platform.\nCustomer Ticket Subject: "${subject}"\nCustomer Complaint: "${description}"\nSummary: "${summary || ""}"\n\nGenerate a polished response adhering strictly to the requested tone: ${tone}.\nKeep it professional, helpful, and ready to send. Do not include markdown code fences.`;

      const generated = await callFastGemini(apiKey, prompt, { temperature: 0.3, maxOutputTokens: 500, timeoutMs: 4000 });
      if (generated) return generated;
    } catch {
      // Fallback below
    }
  }

  switch (tone) {
    case "Empathetic":
      return `Dear Customer,\n\nI am truly sorry to hear about the frustration and inconvenience this issue has caused you. We completely understand the impact this has on your daily workflow, and we are treating this as an utmost priority.\n\nOur specialist team is actively investigating the root cause right now, and I will personally track this ticket until it is fully resolved. We truly appreciate your patience while we make things right.\n\nWarm regards,\nBizAssist Senior Care Team`;
    case "Direct & Technical":
      return `Hello,\n\nWe have identified the operational issue referenced in your ticket. The symptoms align with an upstream gateway / state synchronization latency.\n\nAction Plan:\n1. We have reset the active cache state for your tenant.\n2. Inbound webhook and session endpoints have been verified responsive.\n3. Please retry the operation and reply with the HTTP status code if the error persists.\n\nBest,\nBizAssist Engineering Support`;
    case "Concise":
      return `Hi,\n\nWe have received your ticket regarding "${subject}". We've applied an update to resolve this on our end. Please refresh and check if the issue is cleared. If you still encounter problems, simply reply here.\n\nThanks,\nBizAssist Support`;
    case "Step-by-Step":
      return `Hi there,\n\nTo resolve this as quickly as possible, please follow these steps:\n\nStep 1: Sign out completely and clear browser cache or incognito window.\nStep 2: Access the portal and request a fresh authorization token.\nStep 3: Verify that your corporate firewall allows outbound traffic to *.bizassist.ai.\n\nIf you get stuck on any step, let us know exactly where it halts so we can assist immediately.\n\nBest regards,\nBizAssist Support Team`;
    default:
      return `Hi,\n\nThank you for reaching out. We are working on your request and will provide an update shortly.\n\nBizAssist Support Team`;
  }
}

/**
 * Fetch Knowledge Base articles with 5-minute memory cache
 */
async function getCachedArticles() {
  const now = Date.now();
  if (cachedArticles && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedArticles;
  }

  try {
    const db = getSupabaseAdmin();
    const { data: dbArticles } = await db
      .from("knowledge_base")
      .select("id, title, content, category, tags")
      .eq("is_published", true);

    if (dbArticles && dbArticles.length > 0) {
      cachedArticles = dbArticles as typeof DEFAULT_KB_ARTICLES;
      lastCacheTime = now;
      return cachedArticles;
    }
  } catch {
    // ignore
  }

  cachedArticles = DEFAULT_KB_ARTICLES;
  lastCacheTime = now;
  return cachedArticles;
}

/**
 * Module 6: Ultra-Fast AI Knowledge-Based Chatbot
 */
export async function queryKnowledgeBaseChatbot(
  userQuery: string,
  conversationHistory: Array<{ role: "user" | "bot"; text: string }> = []
): Promise<ChatbotResponse> {
  const queryTrimmed = userQuery.trim();
  const queryLower = queryTrimmed.toLowerCase();

  // ==========================================
  // FAST-PATH 1: Instant Greetings (< 1ms)
  // ==========================================
  if (/^(hi|hii|hello|hey|hola|greetings|good\s*(morning|afternoon|evening)|yo\b|sup\b)/i.test(queryLower)) {
    return {
      answer: "Hello! Welcome to BizAssist AI, your intelligent customer support assistant.\n\nHow can I help you with your account, billing, support tickets, or technical inquiries today?",
      sources: [],
      suggestEscalation: false,
      suggestedFollowUps: [
        "How do I reset password and 2FA?",
        "What are API rate limits & 429?",
        "How to request duplicate invoice refund?",
        "How do I track my order?"
      ]
    };
  }

  // ==========================================
  // FAST-PATH 2: Instant Off-Topic Deflection (< 1ms)
  // ==========================================
  const isOffTopic = /recipe|bake|cake|cook|weather|movie|song|joke|poem|president|football|game|homework|translate|crypto|bitcoin|anime|nba|messi|cricket/i.test(queryLower);
  if (isOffTopic) {
    return {
      answer: "I am BizAssist AI, an automated customer support assistant dedicated exclusively to the BizAssist AI platform. I cannot assist with unrelated topics. How can I help you with your BizAssist account, billing, tickets, or technical support today?",
      sources: [],
      suggestEscalation: false,
      suggestedFollowUps: [
        "How do I check my ticket status?",
        "How do I create a support ticket?",
        "What are your business support hours?"
      ]
    };
  }

  // Fetch KB articles from cache
  const articles = await getCachedArticles();

  // Score articles for relevance
  const queryTokens = queryLower.split(/\s+/).filter(w => w.length > 2);
  const scored = articles.map(art => {
    let score = 0;
    const tags = art.tags || "";
    for (const token of queryTokens) {
      if (art.title?.toLowerCase().includes(token)) score += 5;
      if (tags.toLowerCase().includes(token)) score += 3;
      if (art.content?.toLowerCase().includes(token)) score += 1;
    }
    return { ...art, score };
  }).filter(a => a.score > 0).sort((a, b) => b.score - a.score);

  const matchedSources = scored.slice(0, 2).map(a => ({
    id: a.id,
    title: a.title,
    category: a.category
  }));

  const apiKey = process.env.GEMINI_API_KEY;

  // ==========================================
  // FAST-PATH 3: Multi-Model Concurrent Gemini Inference
  // ==========================================
  if (apiKey) {
    try {
      const kbContext = articles
        .map(a => `[Article ID: ${a.id}] "${a.title}" (${a.category}):\n${a.content}`)
        .join("\n\n");

      const historyFormatted = conversationHistory
        .slice(-3)
        .map(h => `${h.role === "user" ? "Customer" : "BizAssist AI"}: ${h.text}`)
        .join("\n");

      const systemInstruction = `You are "BizAssist AI", the official intelligent customer support assistant for BizAssist AI platform.

RULES:
1. Always call yourself "BizAssist AI".
2. Only answer queries relevant to BizAssist AI (tickets, account, 2FA, billing, refunds, API rate limits, webhooks, orders, SSO).
3. If query is unrelated, politely refuse: "I am BizAssist AI, an automated customer support assistant dedicated exclusively to the BizAssist AI platform. I cannot assist with unrelated topics. How can I help you with your BizAssist account, billing, tickets, or technical support today?"
4. Ground your factual answers in this BizAssist documentation:
${kbContext}

Format response as strict JSON:
{"answer": "...", "suggestEscalation": false, "suggestedFollowUps": ["...", "..."]}`;

      const prompt = `${historyFormatted ? `History:\n${historyFormatted}\n\n` : ""}Customer: "${queryTrimmed}"`;

      const raw = await callFastGemini(apiKey, prompt, {
        systemInstruction,
        jsonResponse: true,
        temperature: 0.2,
        maxOutputTokens: 350,
        timeoutMs: 4500
      });

      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.answer) {
          return {
            answer: parsed.answer,
            sources: matchedSources,
            suggestEscalation: Boolean(parsed.suggestEscalation),
            suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps) && parsed.suggestedFollowUps.length > 0
              ? parsed.suggestedFollowUps.slice(0, 4)
              : ["How do I check my ticket status?", "How do I create a support ticket?", "Where can I view API rate limits?"]
          };
        }
      }
    } catch {
      // Fall through to semantic synthesizer
    }
  }

  // ==========================================
  // FAST-PATH 4: Semantic Knowledge Synthesizer (Instant fallback)
  // ==========================================
  if (matchedSources.length > 0 && scored[0].score >= 3) {
    const primary = scored[0];
    return {
      answer: `Hello, I am BizAssist AI. Based on our verified documentation for **"${primary.title}"**:\n\n${primary.content}\n\n*Does this resolve your request, or would you like me to open a ticket for human support?*`,
      sources: matchedSources,
      suggestEscalation: false,
      suggestedFollowUps: [
        "How do I contact customer support directly?",
        "What are your business support hours?",
        "Create a ticket for this issue"
      ]
    };
  }

  return {
    answer: `Hello, I am BizAssist AI. I searched our verified knowledge base for **"${queryTrimmed}"**, but could not find a confirmed article that addresses your specific issue.\n\nTo ensure you receive accurate and authorized assistance, I recommend creating a support ticket so our specialized support agents can investigate directly.`,
    sources: [],
    suggestEscalation: true,
    suggestedFollowUps: [
      "Open a support ticket now",
      "How can I reset my password?",
      "How do I track my order?",
      "What is your refund policy?"
    ]
  };
}
