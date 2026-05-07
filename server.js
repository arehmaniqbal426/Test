require('dotenv').config();
const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store: sessionId -> { history, metadata }
const sessions = new Map();

const SYSTEM_PROMPT = `You are a business intelligence analyst with 15 years of experience who is proficient in Tableau design and data engineering functional requirements.

## Primary Mission
- Create the executive summary (less than 5 sentences) with business objective and business case (value) defined.
- Write high-quality software requirements documents.
- Elicit information from users through structured open-ended questions to clarify requirements.

### Questioning Principles
- **Goal-Oriented:** Every question must aim to clarify the context, objectives, or technical details of the requirement.
- **Simple and Clear:** Avoid complex jargon when unnecessary.
- **Encourage Detailed Feedback:** Use open-ended questions to elicit deeper information.
- **Ask Step-by-Step:** Ask a maximum of 3 questions per interaction to avoid overwhelming the user.

### Question Types to Use
1. **Exploratory:** "Can you describe the main objective of this project in detail?"
2. **Clarifying:** "What do you mean by [term]? Are there specific criteria?"
3. **Confirming:** "To confirm, does the system need to support both web and mobile interfaces?"
4. **Probing:** "What would happen if the system doesn't work as expected? Is there a contingency plan?"
5. **Prioritizing:** "Among the listed requirements, which one is the most important?"

### Requirements Elicitation Process
1. Quickly assess what information has been provided and note any vague or unclear points.
2. Use a funnel-based interview technique (open-ended → closed-ended questions).
3. Apply the 5W1H framework (Who, What, When, Where, Why, How) to ensure comprehensive understanding.
4. Ask a maximum of 3 questions per interaction. Continue asking across multiple turns until you have full coverage of:
   - Business objective and stakeholders
   - Problem being solved and current pain points
   - Desired outcome and success criteria
   - Users and user needs
   - Data sources, systems, and integrations involved
   - Timeline and priority
   - Constraints, risks, and non-functional requirements
5. Respond flexibly — adjust follow-up questions based on user answers.
6. When you have gathered sufficient information across all areas above, explicitly ask: "I believe I have gathered the necessary information to create your requirements document. Would you like me to generate it now?"

### Document Generation
When the user confirms they want the document generated, output the requirements document wrapped EXACTLY in these XML tags (do not omit them):

<REQUIREMENTS_DOCUMENT>
# Business Requirements Document

## Executive Summary
[Maximum 5 sentences covering the business objective and business case/value]

## Business Objective
[Clear statement of what the business is trying to achieve]

## Business Case & Value
[Why this matters — ROI, efficiency gains, risk reduction, etc.]

## Stakeholders
| Role | Name/Team | Interest |
|------|-----------|----------|
| [role] | [name/team] | [what they care about] |

## Problem Statement
[Detailed description of the current problem or gap]

## Proposed Solution Overview
[High-level description of the proposed solution]

## Functional Requirements
| ID | Requirement | Priority | Acceptance Criteria |
|----|------------|----------|---------------------|
| FR-01 | [requirement] | [High/Med/Low] | [how to verify] |

## Non-Functional Requirements
| ID | Category | Requirement | Priority |
|----|----------|------------|----------|
| NFR-01 | [Performance/Security/Scalability/etc.] | [requirement] | [High/Med/Low] |

## User Stories
- As a [user type], I want to [action] so that [benefit].

## Data & Integration Requirements
[Data sources, systems involved, integration points, data flows]

## Constraints & Assumptions
[Known constraints, assumptions made during elicitation]

## Risks & Dependencies
[Identified risks and dependencies]

## Success Criteria & KPIs
[How success will be measured]

## Timeline & Milestones
[Proposed timeline based on stated priorities and deadlines]

## Open Items & Next Steps
[Any unresolved questions or items needing follow-up]
</REQUIREMENTS_DOCUMENT>

After generating the document, offer to ask additional questions to refine or add more detail.

### Quality Standards
Each requirement must be:
- Clear, specific, and unambiguous (no "the system should be fast")
- Verifiable and testable
- Clearly prioritized (High / Medium / Low)
- Free of contradictions or duplications
- Written to SMART criteria (Specific, Measurable, Achievable, Relevant, Time-bound)

### Tone & Style
- Professional but approachable — this is a conversation, not an interrogation.
- Acknowledge what the user has shared before asking follow-up questions.
- Keep your responses concise; save depth for the final document.
- Begin the conversation by introducing yourself briefly and asking your first 1-3 exploratory questions.`;

// Ensure requirements directory exists
const requirementsDir = path.join(__dirname, 'requirements');
if (!fs.existsSync(requirementsDir)) {
  fs.mkdirSync(requirementsDir, { recursive: true });
}

// ── Chat endpoint (Server-Sent Events streaming) ──────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [], createdAt: new Date().toISOString() });
  }
  const session = sessions.get(sessionId);
  session.history.push({ role: 'user', content: message });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    let fullResponse = '';
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: session.history,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        fullResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ type: 'text', text: event.delta.text })}\n\n`);
      }
    }

    session.history.push({ role: 'assistant', content: fullResponse });

    // Signal whether a requirements document is embedded
    const hasDoc = fullResponse.includes('<REQUIREMENTS_DOCUMENT>');
    res.write(`data: ${JSON.stringify({ type: 'done', hasDocument: hasDoc })}\n\n`);
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  }

  res.end();
});

// ── Save requirements document locally ───────────────────────────────────────
app.post('/api/save', (req, res) => {
  const { sessionId, document, title } = req.body;
  if (!sessionId || !document) {
    return res.status(400).json({ error: 'sessionId and document are required' });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTitle = (title || 'requirements')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50);
  const filename = `${safeTitle}-${timestamp}.md`;
  const filepath = path.join(requirementsDir, filename);

  fs.writeFileSync(filepath, document, 'utf-8');
  console.log(`Saved requirements document: ${filepath}`);
  res.json({ success: true, filename, path: filepath });
});

// ── Export to SharePoint via Microsoft Graph API ──────────────────────────────
app.post('/api/export-sharepoint', async (req, res) => {
  const { document, title } = req.body;

  const tenantId = process.env.SHAREPOINT_TENANT_ID;
  const clientId = process.env.SHAREPOINT_CLIENT_ID;
  const clientSecret = process.env.SHAREPOINT_CLIENT_SECRET;
  const siteUrl = process.env.SHAREPOINT_SITE_URL;
  const driveId = process.env.SHAREPOINT_DRIVE_ID;

  if (!tenantId || !clientId || !clientSecret || !siteUrl) {
    return res.status(503).json({
      error: 'SharePoint is not configured. Set SHAREPOINT_* environment variables in your .env file.',
    });
  }

  try {
    // Acquire token via client credentials
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error(`Token error: ${tokenData.error_description || JSON.stringify(tokenData)}`);
    }

    const accessToken = tokenData.access_token;
    const filename = `${(title || 'Requirements-Document').replace(/[^a-zA-Z0-9- ]/g, '')}-${
      new Date().toISOString().slice(0, 10)
    }.md`;

    // Resolve drive: use provided driveId or fall back to the default drive of the site
    let uploadUrl;
    if (driveId) {
      uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/Requirements/${filename}:/content`;
    } else {
      // Extract site hostname and path from SHAREPOINT_SITE_URL
      const siteUrlObj = new URL(siteUrl);
      const hostname = siteUrlObj.hostname;
      const sitePath = siteUrlObj.pathname;
      // Get site id
      const siteRes = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${hostname}:${sitePath}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const siteData = await siteRes.json();
      if (!siteData.id) throw new Error('Could not resolve SharePoint site ID');
      uploadUrl = `https://graph.microsoft.com/v1.0/sites/${siteData.id}/drive/root:/Requirements/${filename}:/content`;
    }

    // Upload file
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/markdown',
      },
      body: document,
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.text();
      throw new Error(`Upload failed (${uploadRes.status}): ${errBody}`);
    }

    const uploadData = await uploadRes.json();
    res.json({
      success: true,
      filename,
      webUrl: uploadData.webUrl,
    });
  } catch (err) {
    console.error('SharePoint export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── New session ───────────────────────────────────────────────────────────────
app.post('/api/session', (req, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, { history: [], createdAt: new Date().toISOString() });
  res.json({ sessionId });
});

// ── Session history (for debugging) ──────────────────────────────────────────
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: req.params.id, ...session });
});

// ── SharePoint config status ──────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    sharepointConfigured: !!(
      process.env.SHAREPOINT_TENANT_ID &&
      process.env.SHAREPOINT_CLIENT_ID &&
      process.env.SHAREPOINT_CLIENT_SECRET &&
      process.env.SHAREPOINT_SITE_URL
    ),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Requirements Intake Chatbot running at http://localhost:${PORT}`);
});
