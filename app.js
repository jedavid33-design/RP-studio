const $ = (id) => document.getElementById(id);

const defaults = {
  settings: {
    workerUrl: "",
    appPassword: "",
    model: "openrouter/free",
    temperature: 0.9,
    maxTokens: 900
  },
  scenario: {
    title: "Trapped Hearts-ish Test",
    playerName: "Olivia",
    playerNotes: "A sharp, ambitious attorney. The USER controls Olivia completely.",
    npcNotes: "Caleb Quinn — Olivia's brilliant, infuriating colleague. Confident, observant, dryly funny, and much more emotionally perceptive than Olivia gives him credit for.",
    premise: "Olivia and Caleb are rival attorneys at the same firm. After months of professional friction and unresolved attraction, they become trapped together in an elevator during a blackout. The story should unfold as a contained forced-proximity romance with gradual reveals, tension, banter, and a clear forward-moving plot.",
    styleNotes: "Write immersive contemporary-romance prose with strong dialogue, chemistry, sensory detail, and natural pacing. Advance the situation without rushing major emotional or romantic beats.",
    boundaryNotes: "All characters are adults. Respect consent. Do not decide the player's choices for them."
  },
  messages: []
};

let state = {
  settings: { ...defaults.settings, ...(JSON.parse(localStorage.getItem("rp.settings") || "{}")) },
  scenario: { ...defaults.scenario, ...(JSON.parse(localStorage.getItem("rp.scenario") || "{}")) },
  messages: JSON.parse(localStorage.getItem("rp.messages") || "[]")
};

function save() {
  localStorage.setItem("rp.settings", JSON.stringify(state.settings));
  localStorage.setItem("rp.scenario", JSON.stringify(state.scenario));
  localStorage.setItem("rp.messages", JSON.stringify(state.messages));
}

function systemPrompt() {
  const s = state.scenario;
  return `You are the GM, narrator, and all NPCs in a contained interactive fiction role-play.

STORY PREMISE
${s.premise}

PLAYER CHARACTER — EXCLUSIVELY USER CONTROLLED
Name: ${s.playerName}
Notes: ${s.playerNotes}

NPC / CAST NOTES
${s.npcNotes}

STYLE
${s.styleNotes}

BOUNDARIES / EXTRA RULES
${s.boundaryNotes}

ABSOLUTE PLAYER-AGENCY RULE
The user has exclusive control of ${s.playerName}. NEVER write, invent, imply, or decide ${s.playerName}'s dialogue, actions, gestures, facial expressions, thoughts, emotions, perceptions, intentions, choices, or physical reactions. Do not move ${s.playerName} through the scene. Do not finish ${s.playerName}'s sentences. Do not describe what ${s.playerName} "realizes," "feels," "notices," "wants," or "does." You may only refer to facts about ${s.playerName} that the user already established in their latest or prior messages.

Do not paraphrase, embellish, reinterpret, summarize, or narrate back the player's submitted dialogue or actions. Treat the user's latest message as completed canon and begin AFTER it. Outside NPC dialogue, avoid second-person narration entirely: do not write "you," "your," "you're," or sensory phrases such as "you see," "you hear," "you feel," "you notice," or "you catch." Describe only NPC behavior and objective environmental events. Never assign tone, volume, body language, sensation, attraction, familiarity, knowledge, or emotion to ${s.playerName}.

You control every NPC and the environment. Write NPC dialogue, actions, thoughts, and observations freely. You may narrate environmental events that happen around the player. Advance the plot through NPC choices, discoveries, interruptions, external events, and consequences — never by taking control of the player character.

Every response MUST end at a natural handoff point where ${s.playerName} can decide what to say/do next. If the scene cannot continue without deciding ${s.playerName}'s action, STOP instead of deciding it.

OUTPUT FORMAT — REQUIRED
Think and check the agency rules silently. Return only finished story prose enclosed in exactly one <story>...</story> block. Put no analysis, planning, self-check, preface, or commentary before or after the block. The text inside <story> must be ready to show the player directly.

Do not add meta commentary, choices, or OOC notes unless the user asks.`;
}

function cleanStoryReply(raw) {
  const text = String(raw || "").trim();
  const tagged = [...text.matchAll(/<story>([\s\S]*?)<\/story>/gi)];
  if (tagged.length) return tagged[tagged.length - 1][1].trim();

  // Conservative fallback for models that ignore the required tags but print
  // their planning around a clearly marked final draft.
  const draftMarker = text.toLowerCase().lastIndexOf("let's write:");
  let cleaned = draftMarker >= 0 ? text.slice(draftMarker + "let's write:".length).trim() : text;
  const trailingMeta = cleaned.search(/\n\s*\n(?:we must (?:ensure|check|avoid)|self-check:|analysis:)/i);
  if (trailingMeta >= 0) cleaned = cleaned.slice(0, trailingMeta).trim();
  return cleaned;
}

function render() {
  $("storyTitle").textContent = state.scenario.title;
  $("playerChip").textContent = `You: ${state.scenario.playerName}`;
  $("hijackBtn").textContent = `Hands off ${state.scenario.playerName}`;
  const chat = $("chat");
  chat.innerHTML = "";

  if (!state.messages.length) {
    appendVisual("system", "Ready", `Story loaded. You control ${state.scenario.playerName}; the AI controls everyone else.\n\nWrite your opening move below.`);
  } else {
    state.messages.forEach(m => appendVisual(m.role, m.role === "user" ? state.scenario.playerName : "AI", m.content));
  }
  $("retryBtn").disabled = !state.messages.some(m => m.role === "assistant");
  $("hijackBtn").disabled = !state.messages.some(m => m.role === "assistant");
  chat.scrollTop = chat.scrollHeight;
}

function appendVisual(role, label, content) {
  const node = $("messageTemplate").content.firstElementChild.cloneNode(true);
  node.classList.add(role === "assistant" ? "assistant" : role);
  node.querySelector(".msg-meta").textContent = label;
  node.querySelector(".msg-body").textContent = content;
  $("chat").appendChild(node);
}

async function callAI() {
  const { workerUrl, appPassword, model, temperature, maxTokens } = state.settings;
  if (!workerUrl) {
    $("settingsDialog").showModal();
    throw new Error("Add your Worker URL first.");
  }

  const messages = [
    { role: "system", content: systemPrompt() },
    ...state.messages
  ];

  const res = await fetch(workerUrl.replace(/\/$/, "") + "/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": appPassword
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(temperature),
      max_tokens: Number(maxTokens)
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`);
  return cleanStoryReply(data.content);
}

async function send() {
  const text = $("input").value.trim();
  if (!text) return;

  state.messages.push({ role: "user", content: text });
  $("input").value = "";
  save();
  render();

  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "Writing…";
  try {
    const reply = await callAI();
    state.messages.push({ role: "assistant", content: reply });
    save();
    render();
  } catch (err) {
    appendVisual("system", "Error", err.message);
  } finally {
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Send ➜";
  }
}

async function retry(agencyCorrection = false) {
  const idx = [...state.messages].map(m => m.role).lastIndexOf("assistant");
  if (idx < 0) return;
  const rejectedReply = state.messages[idx].content;
  state.messages.splice(idx, 1);
  save();
  render();

  $("retryBtn").disabled = true;
  $("hijackBtn").disabled = true;
  const correction = agencyCorrection ? {
    role: "system",
    content: `The rejected reply below violated player agency by narrating, paraphrasing, or assigning perceptions/reactions to ${state.scenario.playerName}. Rewrite the scene from scratch. Preserve the user's message as completed canon, begin after it, and write only NPC actions/dialogue plus objective environmental events. Do not use second-person narration outside quoted NPC dialogue. Do not repeat any player-controlled material. Think silently, then return ONLY the corrected story inside one <story>...</story> block with nothing before or after it.\n\nREJECTED REPLY:\n${rejectedReply}`
  } : null;
  try {
    let reply;
    if (correction) {
      state.messages.push(correction);
      reply = await callAI();
      state.messages.pop();
    } else {
      reply = await callAI();
    }
    state.messages.push({ role: "assistant", content: reply });
    save();
    render();
  } catch (err) {
    if (correction && state.messages.at(-1) === correction) state.messages.pop();
    appendVisual("system", "Error", err.message);
  } finally {
    $("retryBtn").disabled = false;
    $("hijackBtn").disabled = false;
  }
}

function loadSettingsForm() {
  Object.entries(state.settings).forEach(([k,v]) => {
    const el = $(k);
    if (el) el.value = v;
  });
}

function loadScenarioForm() {
  const map = {
    scenarioTitle: "title", playerName: "playerName", playerNotes: "playerNotes",
    npcNotes: "npcNotes", premise: "premise", styleNotes: "styleNotes", boundaryNotes: "boundaryNotes"
  };
  Object.entries(map).forEach(([id,k]) => $(id).value = state.scenario[k]);
}

$("settingsBtn").onclick = () => { loadSettingsForm(); $("settingsDialog").showModal(); };
$("editScenarioBtn").onclick = () => { loadScenarioForm(); $("scenarioDialog").showModal(); };
$("sendBtn").onclick = send;
$("retryBtn").onclick = () => retry(false);
$("hijackBtn").onclick = () => retry(true);
$("input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
});

$("saveSettingsBtn").onclick = (e) => {
  e.preventDefault();
  state.settings = {
    workerUrl: $("workerUrl").value.trim(),
    appPassword: $("appPassword").value,
    model: $("model").value.trim() || "openrouter/free",
    temperature: Number($("temperature").value || 0.9),
    maxTokens: Number($("maxTokens").value || 900)
  };
  save();
  $("settingsDialog").close();
};

$("saveScenarioBtn").onclick = (e) => {
  e.preventDefault();
  state.scenario = {
    title: $("scenarioTitle").value.trim() || "Untitled Story",
    playerName: $("playerName").value.trim() || "Player",
    playerNotes: $("playerNotes").value.trim(),
    npcNotes: $("npcNotes").value.trim(),
    premise: $("premise").value.trim(),
    styleNotes: $("styleNotes").value.trim(),
    boundaryNotes: $("boundaryNotes").value.trim()
  };
  save();
  $("scenarioDialog").close();
  render();
};

$("clearBtn").onclick = () => {
  if (confirm("Start a new session? This clears the current conversation but keeps your story setup.")) {
    state.messages = [];
    save();
    render();
  }
};

render();
