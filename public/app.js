/* ─── State ──────────────────────────────────────────────────────────────────*/
const state = {
  sessionId: null,
  isStreaming: false,
  documentMarkdown: '',
  documentTitle: 'Business Requirements Document',
  sharepointAvailable: false,
};

/* ─── DOM refs ───────────────────────────────────────────────────────────────*/
const $ = id => document.getElementById(id);
const chatMessages   = $('chatMessages');
const welcomeState   = $('welcomeState');
const chatInputArea  = $('chatInputArea');
const messageInput   = $('messageInput');
const sendBtn        = $('sendBtn');
const statusBadge    = $('statusBadge');
const statusText     = $('statusText');
const docEmpty       = $('docEmpty');
const docContent     = $('docContent');
const docRendered    = $('docRendered');
const docActions     = $('docActions');
const docStatusBar   = $('docStatusBar');
const docStatusText  = $('docStatusText');
const sharepointBtn  = $('sharepointBtn');

/* ─── Init ───────────────────────────────────────────────────────────────────*/
async function init() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  state.sharepointAvailable = cfg.sharepointConfigured || false;
  if (!state.sharepointAvailable) {
    sharepointBtn.title = 'SharePoint not configured — see .env.example';
    sharepointBtn.style.opacity = '0.5';
  }

  $('startBtn').addEventListener('click', startSession);
  $('newSessionBtn').addEventListener('click', confirmNewSession);
  sendBtn.addEventListener('click', sendMessage);
  $('copyBtn').addEventListener('click', copyDocument);
  $('downloadBtn').addEventListener('click', downloadDocument);
  sharepointBtn.addEventListener('click', exportToSharePoint);

  messageInput.addEventListener('input', () => {
    sendBtn.disabled = messageInput.value.trim() === '' || state.isStreaming;
    autoResize(messageInput);
  });

  messageInput.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  // Panel drag-resize
  initPanelResize();
}

/* ─── Session ─────────────────────────────────────────────────────────────── */
async function startSession() {
  const res = await fetch('/api/session', { method: 'POST' });
  const data = await res.json();
  state.sessionId = data.sessionId;

  welcomeState.style.display = 'none';
  chatInputArea.style.display = 'block';
  setStatus('active', 'Connected');

  // Trigger the AI's opening greeting
  await streamAIResponse('__init__');
}

function confirmNewSession() {
  if (!state.sessionId) { startSession(); return; }
  showModal(
    'Start New Session?',
    'This will clear the current conversation and document. Any unsaved work will be lost.',
    async () => {
      state.sessionId = null;
      state.documentMarkdown = '';
      chatMessages.innerHTML = '';
      chatMessages.appendChild(welcomeState);
      welcomeState.style.display = 'flex';
      chatInputArea.style.display = 'none';
      hideDocument();
      setStatus('', 'Ready');
      await startSession();
    }
  );
}

/* ─── Messaging ──────────────────────────────────────────────────────────────*/
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || state.isStreaming) return;

  appendMessage('user', text);
  messageInput.value = '';
  autoResize(messageInput);
  sendBtn.disabled = true;

  await streamAIResponse(text);
}

async function streamAIResponse(userMessage) {
  state.isStreaming = true;
  setStatus('thinking', 'Thinking…');

  // Placeholder bubble with typing indicator
  const { bubble, container } = appendMessage('ai', null, true);

  try {
    const payload = userMessage === '__init__'
      ? { sessionId: state.sessionId, message: 'Hello, please introduce yourself briefly and begin the requirements elicitation process.' }
      : { sessionId: state.sessionId, message: userMessage };

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let firstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let event;
        try { event = JSON.parse(raw); } catch { continue; }

        if (event.type === 'text') {
          if (firstChunk) {
            bubble.innerHTML = '';   // remove typing indicator
            firstChunk = false;
          }
          fullText += event.text;
          bubble.innerHTML = renderMarkdown(fullText);
          scrollToBottom();
        } else if (event.type === 'done') {
          if (event.hasDocument) {
            extractAndShowDocument(fullText);
          }
          setStatus('active', 'Ready');
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }
    }
  } catch (err) {
    bubble.innerHTML = `<em style="color:#DC2626">Error: ${escHtml(err.message)}</em>`;
    setStatus('', 'Error');
    showToast('Connection error — please try again.', 'error');
  } finally {
    state.isStreaming = false;
    sendBtn.disabled = messageInput.value.trim() === '';
  }
}

/* ─── Document extraction ────────────────────────────────────────────────────*/
function extractAndShowDocument(fullText) {
  const open  = fullText.indexOf('<REQUIREMENTS_DOCUMENT>');
  const close = fullText.indexOf('</REQUIREMENTS_DOCUMENT>');
  if (open === -1 || close === -1) return;

  const raw = fullText.slice(open + '<REQUIREMENTS_DOCUMENT>'.length, close).trim();
  state.documentMarkdown = raw;

  // Extract title from first H1
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  if (titleMatch) state.documentTitle = titleMatch[1].trim();

  // Save locally
  fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, document: raw, title: state.documentTitle }),
  }).catch(() => {});

  showDocument(raw);
  showToast('Requirements document generated and saved!', 'success');
}

function showDocument(markdown) {
  docEmpty.style.display = 'none';
  docContent.style.display = 'block';
  docActions.style.display = 'flex';
  docStatusBar.style.display = 'block';
  docRendered.innerHTML = renderMarkdown(markdown);
  docStatusText.textContent = `Generated ${new Date().toLocaleString()} · ${countWords(markdown)} words`;
}

function hideDocument() {
  docEmpty.style.display = 'flex';
  docContent.style.display = 'none';
  docActions.style.display = 'none';
  docStatusBar.style.display = 'none';
  docRendered.innerHTML = '';
}

/* ─── Document actions ───────────────────────────────────────────────────────*/
async function copyDocument() {
  if (!state.documentMarkdown) return;
  try {
    await navigator.clipboard.writeText(state.documentMarkdown);
    showToast('Copied to clipboard!', 'success');
  } catch {
    showToast('Copy failed — try selecting and copying manually.', 'error');
  }
}

function downloadDocument() {
  if (!state.documentMarkdown) return;
  const blob = new Blob([state.documentMarkdown], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${state.documentTitle.replace(/[^a-zA-Z0-9 ]/g, '').trim()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Download started!', 'info');
}

async function exportToSharePoint() {
  if (!state.documentMarkdown) return;
  if (!state.sharepointAvailable) {
    showToast('SharePoint is not configured. See .env.example for setup instructions.', 'error');
    return;
  }
  sharepointBtn.disabled = true;
  sharepointBtn.textContent = 'Uploading…';
  try {
    const res = await fetch('/api/export-sharepoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: state.documentMarkdown, title: state.documentTitle }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Uploaded to SharePoint: ${data.filename}`, 'success');
      if (data.webUrl) window.open(data.webUrl, '_blank');
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`SharePoint error: ${err.message}`, 'error');
  } finally {
    sharepointBtn.disabled = false;
    sharepointBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M7 4.5v5M4.5 7h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> SharePoint`;
  }
}

/* ─── UI helpers ─────────────────────────────────────────────────────────────*/
function appendMessage(role, text, typing = false) {
  const container = document.createElement('div');
  container.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'You' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (typing) {
    bubble.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
  } else if (text) {
    bubble.innerHTML = renderMarkdown(text);
  }

  container.appendChild(avatar);
  container.appendChild(bubble);
  chatMessages.appendChild(container);
  scrollToBottom();

  return { bubble, container };
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setStatus(type, text) {
  statusBadge.className = `status-badge ${type}`;
  statusText.textContent = text;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

/* ─── Markdown renderer (lightweight, no external deps) ──────────────────────*/
function renderMarkdown(md) {
  if (!md) return '';
  let html = escHtml(md);

  // Code blocks (before inline code)
  html = html.replace(/```[\s\S]*?```/g, m => {
    const inner = m.slice(3, -3).replace(/^\w+\n/, '');
    return `<pre><code>${inner}</code></pre>`;
  });

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

  // Bold / italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,         '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Tables
  html = html.replace(/(\|.+\|\n)+/g, m => {
    const rows = m.trim().split('\n');
    const header = rows[0];
    const isHeader = rows[1] && /^\|[-| :]+\|$/.test(rows[1]);
    let table = '<table>';
    rows.forEach((row, i) => {
      if (isHeader && i === 1) return; // skip separator
      const cells = row.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      const tag = (isHeader && i === 0) ? 'th' : 'td';
      table += `<tr>${cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('')}</tr>`;
    });
    return table + '</table>';
  });

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');

  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs (double newlines, not already block elements)
  html = html.replace(/\n\n(?!<[htu]|<li|<bl|<hr|<pre)/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Single newlines → <br> inside paragraphs
  html = html.replace(/\n(?!<)/g, '<br>');

  // Clean up empty paragraphs and wrapping around block elements
  html = html.replace(/<p>\s*(<h[1-6]>|<ul>|<ol>|<table>|<hr>|<pre>|<blockquote>)/g, '$1');
  html = html.replace(/(<\/h[1-6]>|<\/ul>|<\/ol>|<\/table>|<hr>|<\/pre>|<\/blockquote>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function countWords(str) {
  return str.trim().split(/\s+/).length;
}

/* ─── Toast ──────────────────────────────────────────────────────────────────*/
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('toastContainer').appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

/* ─── Modal ──────────────────────────────────────────────────────────────────*/
function showModal(title, body, onConfirm) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent  = body;
  $('modalOverlay').style.display = 'flex';

  const cleanup = () => { $('modalOverlay').style.display = 'none'; };
  $('modalCancel').onclick  = cleanup;
  $('modalConfirm').onclick = () => { cleanup(); onConfirm(); };
}

/* ─── Panel resize ───────────────────────────────────────────────────────────*/
function initPanelResize() {
  const divider  = $('panelDivider');
  const chatPane = document.querySelector('.chat-panel');
  let dragging = false;

  divider.addEventListener('mousedown', e => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const total = document.querySelector('.app-main').offsetWidth;
    const pct   = Math.max(30, Math.min(70, (e.clientX / total) * 100));
    chatPane.style.width = pct + '%';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

/* ─── Bootstrap ──────────────────────────────────────────────────────────────*/
document.addEventListener('DOMContentLoaded', init);
