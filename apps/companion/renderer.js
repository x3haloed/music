const messages = document.getElementById('messages');
const message = document.getElementById('message');
const send = document.getElementById('send');
const status = document.getElementById('status');
const generation = document.getElementById('generation');
const focus = document.getElementById('focus');
const cycle = document.getElementById('cycle');
const contact = document.getElementById('contact');
const consequence = document.getElementById('consequence');
const calls = document.getElementById('calls');
const deliveryNote = document.getElementById('delivery-note');
let renderedSignature = '';

send.addEventListener('click', submit);
message.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
});

window.music.onSnapshot(renderSnapshot);
void load();

async function load() {
  renderSnapshot(await window.music.getSnapshot());
}

async function submit() {
  const text = message.value.trim();
  if (!text) return message.focus();
  setBusy(true);
  deliveryNote.textContent = 'Retaining observation…';
  const result = await window.music.send(text);
  if (!result?.ok) {
    deliveryNote.textContent = result?.error || 'Message was not retained.';
    deliveryNote.dataset.error = 'true';
  } else {
    message.value = '';
    deliveryNote.textContent = 'Retained as ordinary world data.';
    delete deliveryNote.dataset.error;
    setTimeout(load, 100);
  }
  setBusy(false);
  message.focus();
}

function renderSnapshot(snapshot) {
  if (!snapshot?.ok) {
    setStatus('Offline', 'error', snapshot?.error);
    generation.textContent = snapshot?.run || 'Resident unavailable';
    return;
  }
  const presence = snapshot.presence;
  setStatus(presence.label, presence.tone);
  generation.textContent = `Generation ${presence.generation}`;
  focus.textContent = presence.focus || 'No retained continuation focus.';
  const current = snapshot.activity.currentCycle;
  const latest = snapshot.activity.latestCompletedCycle;
  cycle.textContent = current ? `Generation ${current.generation}` : 'Between cycles';
  contact.textContent = current?.world || latest?.world || 'Not yet bound';
  consequence.textContent = latest?.classification || 'None yet';
  calls.textContent = `${snapshot.activity.actorCalls} / ${snapshot.activity.recoverableActorFailures}`;
  renderConversation(snapshot.conversation);
}

function renderConversation(conversation) {
  const signature = conversation.map(item => item.id).join('|');
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  messages.replaceChildren();
  if (conversation.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No messages yet.';
    messages.append(empty);
    return;
  }
  for (const item of conversation) {
    const article = document.createElement('article');
    article.className = `message ${item.direction}`;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = `${item.speaker} · ${formatTime(item.at)} · ${item.deliveryStatus}`;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = item.text;
    article.append(meta, bubble);
    if (item.structuredContent) {
      const details = document.createElement('details');
      details.className = 'message-payload';
      const summary = document.createElement('summary');
      summary.textContent = 'Exact structured message';
      const payload = document.createElement('pre');
      payload.textContent = JSON.stringify(item.structuredContent, null, 2);
      details.append(summary, payload);
      article.append(details);
    }
    messages.append(article);
  }
  messages.scrollTop = messages.scrollHeight;
}

function setStatus(label, tone, title = '') {
  status.textContent = label;
  status.dataset.tone = tone;
  status.title = title || '';
}

function setBusy(value) {
  send.disabled = value;
  message.disabled = value;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
